import { parse, type AnyNode } from 'acorn';
import { posix } from 'node:path';

type Node = AnyNode & Record<string, any>;
const MAX_BYTES = 1024 * 1024;
const OMIT = new Set(['start', 'end', 'loc', 'raw']);

function scalar(node: Node | null): boolean {
  return !!node && ((node.type === 'Literal' && (node.value === null
    || typeof node.value === 'string' || typeof node.value === 'boolean'
    || (typeof node.value === 'number' && Number.isFinite(node.value))))
    || (node.type === 'UnaryExpression' && ['-', '+'].includes(node.operator)
      && node.argument.type === 'Literal' && typeof node.argument.value === 'number' && Number.isFinite(node.argument.value)));
}

function canonical(value: any, bindings = new Map<string, Node>(), propertyName = false): any {
  if (Array.isArray(value)) return value.map((item) => canonical(item, bindings));
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'Identifier' && !propertyName && bindings.has(value.name)) return canonical(bindings.get(value.name));
  const result: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    if (OMIT.has(key)) continue;
    // obj.key's property is not a lexical variable. No object shorthand or nested
    // bindings are accepted in the callback grammar below.
    result[key] = canonical(value[key], bindings, value.type === 'MemberExpression' && !value.computed && key === 'property');
  }
  return result;
}

function pureArgument(node: Node, functions: Set<string>): boolean {
  if (scalar(node)) return true;
  if (node.type === 'CallExpression') return !node.optional && node.callee.type === 'Identifier' && functions.has(node.callee.name)
    && node.arguments.every((argument: Node) => pureArgument(argument, functions));
  return false;
}

type Bindings = { testName: string; assertName: string; functions: Set<string> };
function pureFunction(node: Node): boolean {
  if (!['FunctionDeclaration', 'ArrowFunctionExpression'].includes(node.type) || node.async || node.generator
    || !node.params.every((p: Node) => p.type === 'Identifier')) return false;
  const names = new Set<string>(node.params.map((p: Node) => p.name));
  const body = node.body.type === 'BlockStatement' && node.body.body.length === 1
    && node.body.body[0].type === 'ReturnStatement' ? node.body.body[0].argument : node.body;
  const expression = (value: Node | null): boolean => !!value && (scalar(value)
    || (value.type === 'Identifier' && names.has(value.name))
    || (value.type === 'BinaryExpression' && ['+', '-', '*', '/', '%', '**', '===', '!==', '<', '<=', '>', '>='].includes(value.operator)
      && expression(value.left) && expression(value.right)));
  return expression(body);
}

function pureExports(source: string): Set<string> | undefined {
  if (source.length > MAX_BYTES) return undefined;
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) as Node;
  const exports = new Set<string>();
  for (const node of tree.body) {
    if (node.type !== 'ExportNamedDeclaration' || node.source || node.specifiers.length || !node.declaration) return undefined;
    const d = node.declaration;
    if (d.type === 'FunctionDeclaration' && d.id && pureFunction(d)) exports.add(d.id.name);
    else if (d.type === 'VariableDeclaration' && d.kind === 'const' && d.declarations.length === 1) {
      const item = d.declarations[0];
      if (item.id.type !== 'Identifier' || !item.init || !pureFunction(item.init)) return undefined;
      exports.add(item.id.name);
    } else return undefined;
  }
  return exports;
}

function importBindings(program: Node, path: string, readDependency?: (path: string) => string | undefined): Bindings | undefined {
  let testName = '', assertName = '';
  const functions = new Set<string>();
  const imports = program.body.filter((node: Node) => node.type === 'ImportDeclaration');
  if (imports.length > 8) return undefined;
  for (const node of imports) {
    const source = node.source.value;
    if (source === 'node:test' && node.specifiers.length === 1 && !testName) {
      const s = node.specifiers[0];
      if (s.type !== 'ImportDefaultSpecifier' && !(s.type === 'ImportSpecifier' && s.imported.name === 'test')) return undefined;
      testName = s.local.name;
    } else if (source === 'node:assert/strict' && node.specifiers.length === 1 && !assertName && node.specifiers[0].type === 'ImportDefaultSpecifier') {
      assertName = node.specifiers[0].local.name;
    } else {
      // Node resolves ESM specifiers as URLs. Percent escapes, fragments,
      // queries and backslashes must not select a different file than Git read.
      if (typeof source !== 'string' || !/^\.{1,2}\/[A-Za-z0-9_./-]+\.m?js$/.test(source)
        || !readDependency || !node.specifiers.length) return undefined;
      const modulePath = posix.normalize(posix.join(posix.dirname(path), source));
      if (modulePath.startsWith('../') || posix.isAbsolute(modulePath)) return undefined;
      const text = readDependency(modulePath);
      if (text === undefined) return undefined;
      const exports = pureExports(text);
      if (!exports) return undefined;
      for (const s of node.specifiers) {
        if (s.type !== 'ImportSpecifier' || !exports.has(s.imported.name)) return undefined;
        functions.add(s.local.name);
      }
    }
  }
  return testName && assertName ? { testName, assertName, functions } : undefined;
}

function titleIsPure(node: Node, bindings: Map<string, Node>): boolean {
  return (node.type === 'Literal' && typeof node.value === 'string')
    || (node.type === 'TemplateLiteral' && node.expressions.every((part: Node) => scalar(part)
      || (part.type === 'Identifier' && bindings.has(part.name))));
}

function registration(statement: Node, imports: Bindings, bindings = new Map<string, Node>()): any | undefined {
  const { testName, assertName, functions } = imports;
  if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'CallExpression') return undefined;
  const call = statement.expression;
  if (call.optional || call.callee.type !== 'Identifier' || call.callee.name !== testName || call.arguments.length !== 2) return undefined;
  const [title, callback] = call.arguments;
  if (!titleIsPure(title, bindings) || callback.type !== 'ArrowFunctionExpression'
    || callback.params.length !== 0 || callback.async) return undefined;
  const body = canonical(callback.body, bindings);
  if (body.type !== 'CallExpression' || body.optional || body.arguments.length !== 2
    || body.callee.type !== 'MemberExpression' || body.callee.computed || body.callee.optional
    || body.callee.object.type !== 'Identifier' || body.callee.object.name !== assertName
    || body.callee.property.type !== 'Identifier' || !['equal', 'strictEqual'].includes(body.callee.property.name)
    || !body.arguments.every((arg: Node) => pureArgument(arg, functions))) return undefined;
  // Pure titles may change; the invoked callback expressions and their ordering
  // must be identical. This is not a claim about runner name filters or coverage.
  return { registration: testName, callback: body };
}

function expanded(program: Node, imports: Bindings): { statements: any[]; loops: number } | undefined {
  const { testName } = imports;
  const statements: any[] = []; let loops = 0;
  for (const node of program.body) {
    if (node.type !== 'ForOfStatement') {
      if (node.type === 'ImportDeclaration') statements.push(canonical(node));
      else {
        const call = registration(node, imports);
        if (!call) return undefined;
        statements.push(call);
      }
      continue;
    }
    if (node.await || node.left.type !== 'VariableDeclaration' || node.left.kind !== 'const' || node.left.declarations.length !== 1) return undefined;
    const declaration = node.left.declarations[0];
    if (declaration.init || declaration.id.type !== 'ArrayPattern' || !declaration.id.elements.length
      || !declaration.id.elements.every((item: Node | null) => item?.type === 'Identifier')) return undefined;
    const names: string[] = declaration.id.elements.map((item: Node) => item.name);
    if (new Set(names).size !== names.length || names.includes(testName)) return undefined;
    if (node.right.type !== 'ArrayExpression' || node.right.elements.length < 1 || node.right.elements.length > 200) return undefined;
    const body = node.body.type === 'BlockStatement' && node.body.body.length === 1 ? node.body.body[0] : node.body;
    for (const row of node.right.elements) {
      if (!row || row.type !== 'ArrayExpression' || row.elements.length !== names.length || !row.elements.every(scalar)) return undefined;
      const bindings = new Map<string, Node>(names.map((name, i) => [name, row.elements[i]]));
      const call = registration(body, imports, bindings);
      if (!call) return undefined;
      statements.push(call);
    }
    loops++;
  }
  return { statements, loops };
}

/** Narrow full-file recognition, never evaluation of candidate code or row counts alone. */
export function preservesLiteralTestParameterization(path: string, before: string, after: string, testCommand?: string, readDependency?: (path: string) => string | undefined): boolean {
  if (!/\.(?:m?js)$/.test(path) || before.length > MAX_BYTES || after.length > MAX_BYTES || process.env.NODE_OPTIONS?.trim()) return false;
  // Only a caller-supplied plain Node test command with explicit file selection
  // can use this recognition. Name filters, preloads, wrappers, shell operators
  // and source-only audits keep their conservative count-loss result.
  // Newlines are shell command boundaries, not interchangeable argument spaces.
  // Restrict recognition to one printable ASCII command with optional tabs.
  if (!testCommand || /[^\x20-\x7e\t]/.test(testCommand)) return false;
  const args = testCommand.trim().split(/[ \t]+/);
  if (args[0] !== 'node' || args[1] !== '--test') return false;
  const selections = args.slice(2).filter((arg) => !/^--test-(?:reporter=tap|concurrency=[1-9][0-9]*)$/.test(arg));
  if (!selections.length || selections.some((arg) => !/^[A-Za-z0-9_.\/*-]+\.[cm]?js$/.test(arg) || arg.includes('**'))) return false;
  const selected = selections.some((arg) => {
    // Shell wildcard expansion normally omits dotfiles and hidden directories.
    // Do not claim a wildcard selects them; an exact literal path can qualify.
    if (arg.includes('*') && path.split('/').some((part) => part.startsWith('.'))) return false;
    const pattern = arg.replace(/^\.\//, '').split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
    return new RegExp('^' + pattern + '$').test(path);
  });
  if (!selected) return false;
  try {
    const left = parse(before, { ecmaVersion: 'latest', sourceType: 'module' }) as Node;
    const right = parse(after, { ecmaVersion: 'latest', sourceType: 'module' }) as Node;
    const imports = importBindings(left, path, readDependency);
    if (!imports) return false;
    const a = expanded(left, imports), b = expanded(right, imports);
    return !!a && !!b && a.loops === 0 && b.loops > 0
      && JSON.stringify(a.statements) === JSON.stringify(b.statements);
  } catch { return false; }
}
