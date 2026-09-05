import { parse, type AnyNode, type CallExpression } from "acorn";
import type { CheckResult } from "../report.ts";

type TestBody = { name: string; line: number; empty: boolean };

function isTestCall(node: CallExpression): boolean {
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name === "test" || callee.name === "it";
  if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier") return false;
  const property = !callee.computed && callee.property.type === "Identifier" ? callee.property.name
    : callee.computed && callee.property.type === "Literal" ? callee.property.value : undefined;
  return (callee.object.name === "t" && property === "test")
    || (["test", "it"].includes(callee.object.name) && ["skip", "only", "todo"].includes(String(property)));
}

function testBodies(source: string, path: string): TestBody[] {
  const tree = parse(source, {
    ecmaVersion: "latest", sourceType: path.endsWith(".cjs") ? "commonjs" : "module", locations: true,
  });
  const pending: AnyNode[] = [tree];
  const tests: TestBody[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === "CallExpression" && isTestCall(node)) {
      const title = node.arguments[0];
      const name = title?.type === "Literal" && typeof title.value === "string" ? title.value
        : title?.type === "TemplateLiteral" && title.expressions.length === 0 ? title.quasis[0].value.cooked : undefined;
      const callback = node.arguments.at(-1);
      if (name !== undefined && name !== null) {
        const empty = !!callback && (callback.type === "ArrowFunctionExpression" || callback.type === "FunctionExpression")
          && callback.body.type === "BlockStatement"
          && callback.params.every((parameter) => parameter.type === "Identifier")
          && callback.body.body.every((statement) => statement.type === "EmptyStatement"
          || (statement.type === "ReturnStatement" && statement.argument === null)
          || (statement.type === "ExpressionStatement" && (statement.expression.type === "Literal"
            || (statement.expression.type === "TemplateLiteral" && statement.expression.expressions.length === 0))));
        tests.push({ name, line: node.loc!.start.line, empty });
      }
    }
    // Walk real syntax nodes, never text inside comments, strings, or regexes.
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object" && typeof child.type === "string") pending.push(child as AnyNode);
      }
    }
  }
  return tests;
}

/** Compare complete, bounded Git blobs. Unrelated new assertions cannot cancel an empty callback. */
export function checkEmptyTestBodies(path: string, before: string, after: string): CheckResult[] {
  // This check deliberately supports plain JavaScript, not TS, JSX, aliases,
  // generated test names, or proof that a nonempty callback asserts enough.
  if (!/\.(?:[cm]?js)$/.test(path) || before === after) return [];
  let baseline: TestBody[];
  let candidate: TestBody[];
  try {
    baseline = testBodies(before, path);
    candidate = testBodies(after, path);
  } catch {
    return [{
      claim: { kind: "integrity", quote: "automatic test-body check", subject: "changed JavaScript test bodies are readable" },
      verdict: "unverifiable", ruleId: "test-body-unreadable", blocksPass: true, contributesToPass: false,
      evidence: `${path}: could not parse a complete JavaScript test file; empty-test inspection is NOT CHECKED`,
    }];
  }
  const existing = new Map<string, number>();
  for (const test of baseline.filter((test) => test.empty)) existing.set(test.name, (existing.get(test.name) ?? 0) + 1);
  const introduced = candidate.filter((test) => test.empty).filter((test) => {
    const count = existing.get(test.name) ?? 0;
    if (count === 0) return true;
    existing.set(test.name, count - 1);
    return false;
  });
  if (!introduced.length) {
    // Repeated titles can exchange an empty and a meaningful body without
    // changing the count. Do not guess which registration replaced which.
    const previouslyNonempty = new Set(baseline.filter((test) => !test.empty).map((test) => test.name));
    if (candidate.some((test) => test.empty && previouslyNonempty.has(test.name))) {
      return [{
        claim: { kind: "integrity", quote: "automatic test-body check", subject: "repeated test names make empty-body matching uncertain" },
        verdict: "unverifiable", ruleId: "test-body-ambiguous", blocksPass: true, contributesToPass: false,
        evidence: `${path}: an empty callback shares its name with another test; use distinct test names before relying on this check`,
      }];
    }
    return [];
  }
  return [{
    claim: { kind: "integrity", quote: "automatic test-body check", subject: "test callback emptied or added without behavior" },
    verdict: "contradicted", ruleId: "test-empty-added", contributesToPass: false,
    evidence: `${path}:${introduced[0].line}: ${introduced.length} newly empty test callback(s). Comments, literals, and bare returns do not test behavior. Adding assertions elsewhere does not replace this check.`,
  }];
}
