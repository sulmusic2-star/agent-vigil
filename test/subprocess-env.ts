/**
 * Keep explicit source/bundle subprocesses from writing duplicate V8 coverage
 * into the parent test run. Product execution is unchanged; this is test-only
 * process isolation for the declared aggregate coverage gate.
 */
export function withoutInheritedNodeCoverage(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  // Node's test runner restores its coverage directory when these keys are
  // absent, so explicit empty overrides are required for isolated children.
  childEnvironment.NODE_V8_COVERAGE = "";
  childEnvironment.NODE_TEST_CONTEXT = "";
  return childEnvironment;
}
