import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsRoot = join(serviceRoot, "migrations");
const fixturesRoot = join(serviceRoot, "test", "fixtures");
const wrangler = join(serviceRoot, "node_modules", ".bin", "wrangler");

assert.ok(existsSync(wrangler), `Wrangler executable is missing: ${wrangler}`);

function run(root, args, { expectFailure = false } = {}) {
  const result = spawnSync(wrangler, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    maxBuffer: 16 * 1024 * 1024
  });
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (expectFailure) {
    assert.notEqual(result.status, 0, `Expected command to fail:\n${combined}`);
    return combined;
  }
  assert.equal(result.status, 0, `Command failed (${args.join(" ")}):\n${combined}`);
  return result.stdout ?? "";
}

function config(root) {
  const path = join(root, "wrangler.json");
  writeFileSync(
    path,
    JSON.stringify({
      name: `migration-0008-${basename(root).toLowerCase()}`,
      compatibility_date: "2026-08-23",
      d1_databases: [
        {
          binding: "TEAM_CONTROL_DB",
          database_name: "migration-0008-verification",
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: "migrations"
        }
      ]
    })
  );
  return path;
}

function copyMigrations(root, include0008) {
  const target = join(root, "migrations");
  mkdirSync(target, { recursive: true });
  for (let version = 1; version <= (include0008 ? 8 : 7); version += 1) {
    const prefix = String(version).padStart(4, "0");
    const source = readFileSync(join(migrationsRoot, `${prefix}${[
      "_team_control_plane.sql",
      "_provider_state_cursor.sql",
      "_github_app_installations.sql",
      "_r0_measurement_plane.sql",
      "_measurement_integrity_guards.sql",
      "_individual_measurement_lane.sql",
      "_team_integrity_guards.sql",
      "_billing_generation_and_github_lifecycle.sql"
    ][version - 1]}`));
    writeFileSync(join(target, `${prefix}_${version === 8 ? "billing_generation_and_github_lifecycle" : "legacy"}.sql`), source);
  }
}

function apply(root, configPath, persist) {
  return run(root, [
    "d1",
    "migrations",
    "apply",
    "TEAM_CONTROL_DB",
    "--config",
    configPath,
    "--local",
    "--persist-to",
    persist
  ]);
}

function fixture(root, configPath, persist, name) {
  run(root, [
    "d1",
    "execute",
    "TEAM_CONTROL_DB",
    "--config",
    configPath,
    "--local",
    "--persist-to",
    persist,
    "--file",
    join(fixturesRoot, name),
    "--yes"
  ]);
}

function query(root, configPath, persist, sql) {
  const output = run(root, [
    "d1",
    "execute",
    "TEAM_CONTROL_DB",
    "--config",
    configPath,
    "--local",
    "--persist-to",
    persist,
    "--command",
    sql,
    "--json"
  ]);
  const parsed = JSON.parse(output);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].success, true);
  return parsed[0].results;
}

function populatedUpgrade() {
  const root = mkdtempSync(join(tmpdir(), "team-migration-0008-consistent-"));
  const persist = join(root, "persist");
  const configPath = config(root);
  try {
    copyMigrations(root, false);
    apply(root, configPath, persist);
    fixture(root, configPath, persist, "migration-0008-v7-consistent.sql");
    copyMigrations(root, true);
    apply(root, configPath, persist);

    assert.deepEqual(
      query(
        root,
        configPath,
        persist,
        `SELECT org_id, generation, checkout_intent_id, internal_price_id, status,
                provider_checkout_session_id, provider_customer_id, provider_subscription_id
           FROM billing_generations ORDER BY org_id, generation`
      ),
      [
        {
          org_id: "org_live",
          generation: 1,
          checkout_intent_id: "checkout_live",
          internal_price_id: "team_monthly_usd_v1",
          status: "bound",
          provider_checkout_session_id: "cs_live",
          provider_customer_id: "cus_live",
          provider_subscription_id: "sub_live"
        },
        {
          org_id: "org_successor",
          generation: 1,
          checkout_intent_id: "checkout_successor_old",
          internal_price_id: "team_annual_usd_v1",
          status: "retired",
          provider_checkout_session_id: "cs_successor_old",
          provider_customer_id: "cus_successor_old",
          provider_subscription_id: "sub_successor_old"
        },
        {
          org_id: "org_successor",
          generation: 2,
          checkout_intent_id: "checkout_successor_new",
          internal_price_id: "team_monthly_usd_v1",
          status: "reserved",
          provider_checkout_session_id: null,
          provider_customer_id: null,
          provider_subscription_id: null
        }
      ]
    );

    assert.deepEqual(
      query(
        root,
        configPath,
        persist,
        `SELECT id,
                CAST(json_extract(command_json, '$.parameters.metadata.billing_generation') AS INTEGER) AS checkout_generation,
                CAST(json_extract(command_json, '$.billing_generation') AS INTEGER) AS cancellation_generation
           FROM billing_commands
          WHERE id IN ('command_live_cancel', 'command_successor_new') ORDER BY id`
      ),
      [
        { id: "command_live_cancel", checkout_generation: null, cancellation_generation: 1 },
        { id: "command_successor_new", checkout_generation: 2, cancellation_generation: null }
      ]
    );

    assert.deepEqual(
      query(
        root,
        configPath,
        persist,
        `SELECT event_id,
                CAST(json_extract(summary_json, '$.billingGeneration') AS INTEGER) AS generation,
                json_extract(summary_json, '$.billingGenerationSource') AS source,
                json_type(summary_json, '$.reportedBillingGeneration') AS reported_type
           FROM provider_events
          WHERE event_id IN ('evt_live_awaiting', 'evt_live_invoice', 'evt_successor_deleted')
          ORDER BY event_id`
      ),
      [
        { event_id: "evt_live_awaiting", generation: 1, source: "legacy_unique_binding", reported_type: "null" },
        { event_id: "evt_live_invoice", generation: 1, source: "legacy_unique_binding", reported_type: "null" },
        { event_id: "evt_successor_deleted", generation: 1, source: "legacy_unique_binding", reported_type: "null" }
      ]
    );

    assert.deepEqual(
      query(
        root,
        configPath,
        persist,
        `SELECT installation_id, incarnation, account_type, creation_delivery_id,
                latest_delivery_id, latest_action, terminal
           FROM github_installation_lifecycle_heads ORDER BY installation_id`
      ),
      [
        {
          installation_id: 7001,
          incarnation: 1,
          account_type: "Organization",
          creation_delivery_id: "delivery_org_created",
          latest_delivery_id: "delivery_org_created",
          latest_action: "created",
          terminal: 0
        },
        {
          installation_id: 7002,
          incarnation: 1,
          account_type: "User",
          creation_delivery_id: "delivery_personal_created",
          latest_delivery_id: "delivery_personal_created",
          latest_action: "created",
          terminal: 0
        }
      ]
    );

    assert.deepEqual(
      query(
        root,
        configPath,
        persist,
        `SELECT
           (SELECT incarnation FROM github_installation_reconciliations
             WHERE reconciliation_id = 'recon_org_created') AS org_incarnation,
           (SELECT incarnation FROM github_personal_installation_reconciliations
             WHERE reconciliation_id = 'recon_personal_created') AS personal_incarnation,
           (SELECT COUNT(*) FROM workflow_integrity_receipts
             WHERE workflow_type = 'legacy_billing_generation_bridge_eligible') AS eligible_receipts`
      ),
      [{ org_incarnation: 1, personal_incarnation: 1, eligible_receipts: 3 }]
    );

    apply(root, configPath, persist);
    assert.deepEqual(
      query(root, configPath, persist, "SELECT COUNT(*) AS count FROM billing_generations"),
      [{ count: 3 }]
    );
  } finally {
    if (process.env.KEEP_MIGRATION_0008_TMP !== "1") rmSync(root, { recursive: true, force: true });
    else console.log(`Preserved populated migration fixture at ${root}`);
  }
}

function ambiguousUpgradeHolds() {
  const root = mkdtempSync(join(tmpdir(), "team-migration-0008-ambiguous-"));
  const persist = join(root, "persist");
  const configPath = config(root);
  try {
    copyMigrations(root, false);
    apply(root, configPath, persist);
    fixture(root, configPath, persist, "migration-0008-v7-ambiguous.sql");
    copyMigrations(root, true);
    const output = run(
      root,
      [
        "d1",
        "migrations",
        "apply",
        "TEAM_CONTROL_DB",
        "--config",
        configPath,
        "--local",
        "--persist-to",
        persist
      ],
      { expectFailure: true }
    );
    assert.match(output, /CHECK constraint failed/u);
    assert.deepEqual(
      query(
        root,
        configPath,
        persist,
        "SELECT COUNT(*) AS count FROM d1_migrations WHERE name LIKE '0008%'"
      ),
      [{ count: 0 }]
    );
  } finally {
    if (process.env.KEEP_MIGRATION_0008_TMP !== "1") rmSync(root, { recursive: true, force: true });
    else console.log(`Preserved ambiguous migration fixture at ${root}`);
  }
}

populatedUpgrade();
ambiguousUpgradeHolds();
console.log("migration 0008 populated, idempotent, and ambiguous-HOLD fixtures passed");
