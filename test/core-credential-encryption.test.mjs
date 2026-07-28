import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { SqliteAuthState } from "../dist/auth/sqliteAuthState.js";
import { ensureStateOwnership } from "../dist/storage/accountState.js";
import { SqliteState } from "../dist/storage/database.js";
import { purgeLocalState } from "../dist/whatsapp/core.js";
import { temporaryState } from "./core-helpers.mjs";

test("auth rows hide canaries, use fresh nonces, and survive a normal close", async () => {
  const fixture = await temporaryState();
  let auth;
  let reopened;
  try {
    const credentialCanary = "credential-canary-plain-text";
    const signalCanary = "signal-canary-plain-text";
    auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    const update = {
      registered: true,
      me: { id: "919999999999:1@s.whatsapp.net", name: credentialCanary },
    };
    await auth.saveCreds(update);
    const first = fixture.state.db.prepare(
      "SELECT ciphertext FROM auth_credentials WHERE id = 1",
    ).get().ciphertext;
    await auth.saveCreds(update);
    const second = fixture.state.db.prepare(
      "SELECT ciphertext FROM auth_credentials WHERE id = 1",
    ).get().ciphertext;
    await auth.state.keys.set({
      "sender-key-memory": { one: { [signalCanary]: true } },
    });
    const signal = fixture.state.db.prepare(
      "SELECT ciphertext FROM auth_keys WHERE category = ? AND key_id = ?",
    ).get("sender-key-memory", "one").ciphertext;

    assert.notEqual(first, second);
    assert.notEqual(JSON.parse(first).n, JSON.parse(second).n);
    for (const ciphertext of [first, second, signal]) {
      assert.equal(ciphertext.includes(credentialCanary), false);
      assert.equal(ciphertext.includes(signalCanary), false);
    }
    fixture.state.db.pragma("wal_checkpoint(TRUNCATE)");
    const databaseBytes = await fs.readFile(fixture.paths.databaseFile);
    assert.equal(databaseBytes.includes(Buffer.from(credentialCanary)), false);
    assert.equal(databaseBytes.includes(Buffer.from(signalCanary)), false);

    await auth.close();
    auth = undefined;
    assert.equal(fixture.masterKeyStore.keys.size, 1);
    await fs.access(fixture.paths.credentialVaultFile);
    reopened = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    assert.equal(reopened.state.creds.me.name, credentialCanary);
    assert.deepEqual(
      await reopened.state.keys.get("sender-key-memory", ["one"]),
      { one: { [signalCanary]: true } },
    );
  } finally {
    await auth?.close();
    await reopened?.close();
    await fixture.cleanup();
  }
});

test("tampered, wrong-key, and missing-key auth fail closed without key replacement", async () => {
  const fixture = await temporaryState();
  let auth;
  try {
    auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    await auth.saveCreds({ registered: true });
    await auth.close();
    auth = undefined;

    const row = fixture.state.db.prepare(
      "SELECT ciphertext FROM auth_credentials WHERE id = 1",
    ).get();
    const envelope = JSON.parse(row.ciphertext);
    envelope.c = flipBase64UrlCharacter(envelope.c);
    fixture.state.db.prepare(
      "UPDATE auth_credentials SET ciphertext = ? WHERE id = 1",
    ).run(JSON.stringify(envelope));
    const createCalls = fixture.masterKeyStore.createCalls;
    await assert.rejects(
      SqliteAuthState.open(fixture.state, fixture.masterKeyStore),
      hasCode("auth_ciphertext_invalid"),
    );
    assert.equal(fixture.masterKeyStore.createCalls, createCalls);

    fixture.state.db.prepare(
      "UPDATE auth_credentials SET ciphertext = ? WHERE id = 1",
    ).run(row.ciphertext);
    const [keyId, storedKey] = [...fixture.masterKeyStore.keys.entries()][0];
    fixture.masterKeyStore.keys.set(keyId, Uint8Array.from(randomBytes(32)));
    await assert.rejects(
      SqliteAuthState.open(fixture.state, fixture.masterKeyStore),
      hasCode("auth_ciphertext_invalid"),
    );
    assert.equal(fixture.masterKeyStore.createCalls, createCalls);

    fixture.masterKeyStore.keys.set(keyId, Uint8Array.from(storedKey));
    fixture.masterKeyStore.keys.delete(keyId);
    await assert.rejects(
      SqliteAuthState.open(fixture.state, fixture.masterKeyStore),
      hasCode("credential_key_missing"),
    );
    assert.equal(fixture.masterKeyStore.createCalls, createCalls);
    assert.equal(fixture.masterKeyStore.keys.size, 0);
  } finally {
    await auth?.close();
    await fixture.cleanup();
  }
});

test("auth-key ciphertext cannot be swapped between AAD-bound rows", async () => {
  const fixture = await temporaryState();
  let auth;
  try {
    auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    await auth.state.keys.set({
      session: {
        alpha: Buffer.from("alpha-secret"),
        beta: Buffer.from("beta-secret"),
      },
    });
    const rows = fixture.state.db.prepare(`
      SELECT key_id, ciphertext, updated_at
      FROM auth_keys
      WHERE category = 'session'
      ORDER BY key_id
    `).all();
    assert.deepEqual(rows.map((row) => row.key_id), ["alpha", "beta"]);
    const update = fixture.state.db.prepare(`
      UPDATE auth_keys SET ciphertext = ?, updated_at = ?
      WHERE category = 'session' AND key_id = ?
    `);
    fixture.state.db.transaction(() => {
      update.run(rows[1].ciphertext, rows[1].updated_at, "alpha");
      update.run(rows[0].ciphertext, rows[0].updated_at, "beta");
    })();

    await assert.rejects(
      auth.state.keys.get("session", ["alpha"]),
      hasCode("auth_ciphertext_invalid"),
    );
  } finally {
    await auth?.close();
    await fixture.cleanup();
  }
});

test("schema v7 plaintext auth is discarded and scrubbed during the v8 migration", async () => {
  const fixture = await temporaryState();
  let migrated;
  try {
    const credentialCanary = "legacy-credential-canary-plain-text";
    const signalCanary = "legacy-signal-canary-plain-text";
    fixture.state.db.transaction(() => {
      fixture.state.db.exec(`
        DROP TABLE auth_keys;
        DROP TABLE auth_credentials;
        CREATE TABLE auth_credentials (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE auth_keys (
          category TEXT NOT NULL,
          key_id TEXT NOT NULL,
          json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (category, key_id)
        );
      `);
      fixture.state.db.prepare(
        "INSERT INTO auth_credentials (id, json, updated_at) VALUES (1, ?, ?)",
      ).run(JSON.stringify({ registered: true, credentialCanary }), Date.now());
      fixture.state.db.prepare(
        "INSERT INTO auth_keys (category, key_id, json, updated_at) VALUES (?, ?, ?, ?)",
      ).run("session", "legacy", JSON.stringify({ signalCanary }), Date.now());
      fixture.state.db.prepare(
        "INSERT INTO local_meta (key, value) VALUES (?, ?)",
      ).run("migration-survivor", "message-cache-metadata-survives");
      fixture.state.db.pragma("user_version = 7");
    })();
    fixture.state.close();

    migrated = await SqliteState.open(fixture.paths);
    assert.equal(migrated.db.pragma("user_version", { simple: true }), 8);
    assert.equal(migrated.hasAuthRecords(), false);
    assert.deepEqual(
      migrated.db.pragma("table_info(auth_credentials)").map((column) => column.name),
      ["id", "ciphertext", "registered", "updated_at"],
    );
    assert.equal(
      migrated.db.prepare("SELECT value FROM local_meta WHERE key = ?").get("migration-survivor").value,
      "message-cache-metadata-survives",
    );
    migrated.close();
    migrated = undefined;

    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const bytes = await readIfPresent(`${fixture.paths.databaseFile}${suffix}`);
      assert.equal(bytes.includes(Buffer.from(credentialCanary)), false, `credential canary in ${suffix || "database"}`);
      assert.equal(bytes.includes(Buffer.from(signalCanary)), false, `signal canary in ${suffix || "database"}`);
    }
  } finally {
    migrated?.close();
    await fixture.cleanup();
  }
});

test("credential-vault retirement deletes the key and descriptor rather than acting like close", async () => {
  const fixture = await temporaryState();
  let auth;
  try {
    auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    await auth.saveCreds({ registered: true });
    await auth.close();
    auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    assert.equal(fixture.masterKeyStore.keys.size, 1);

    await auth.retireCredentialVault();
    assert.equal(fixture.masterKeyStore.keys.size, 0);
    await assert.rejects(fs.access(fixture.paths.credentialVaultFile));
    await assert.rejects(
      auth.saveCreds({ registered: true }),
      hasCode("auth_state_closed"),
    );
    assert.equal(fixture.masterKeyStore.keys.size, 0);
    await assert.rejects(fs.access(fixture.paths.credentialVaultFile));
    const createCalls = fixture.masterKeyStore.createCalls;
    await assert.rejects(
      SqliteAuthState.open(fixture.state, fixture.masterKeyStore),
      hasCode("credential_key_missing"),
    );
    assert.equal(fixture.masterKeyStore.createCalls, createCalls);
  } finally {
    await auth?.close();
    await fixture.cleanup();
  }
});

test("unsupported envelopes and invalid credential-vault descriptors fail with stable codes", async () => {
  const fixture = await temporaryState();
  let auth;
  try {
    auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    await auth.saveCreds({ registered: true });
    await auth.close();
    auth = undefined;

    const row = fixture.state.db.prepare(
      "SELECT ciphertext FROM auth_credentials WHERE id = 1",
    ).get();
    const unsupported = JSON.parse(row.ciphertext);
    unsupported.v = 2;
    fixture.state.db.prepare(
      "UPDATE auth_credentials SET ciphertext = ? WHERE id = 1",
    ).run(JSON.stringify(unsupported));
    await assert.rejects(
      SqliteAuthState.open(fixture.state, fixture.masterKeyStore),
      hasCode("auth_ciphertext_invalid"),
    );

    const malformed = JSON.parse(row.ciphertext);
    malformed.n = "not+base64url";
    fixture.state.db.prepare(
      "UPDATE auth_credentials SET ciphertext = ? WHERE id = 1",
    ).run(JSON.stringify(malformed));
    await assert.rejects(
      SqliteAuthState.open(fixture.state, fixture.masterKeyStore),
      hasCode("auth_ciphertext_invalid"),
    );
    fixture.state.db.prepare(
      "UPDATE auth_credentials SET ciphertext = ? WHERE id = 1",
    ).run(row.ciphertext);

    const descriptor = await fs.readFile(fixture.paths.credentialVaultFile, "utf8");
    await fs.writeFile(
      fixture.paths.credentialVaultFile,
      '{"version":1,"vaultId":"invalid","keyVersion":1}\n',
    );
    await assert.rejects(
      SqliteAuthState.open(fixture.state, fixture.masterKeyStore),
      hasCode("credential_vault_invalid"),
    );

    if (process.platform !== "win32") {
      const target = `${fixture.paths.credentialVaultFile}.target`;
      await fs.writeFile(target, descriptor);
      await fs.rm(fixture.paths.credentialVaultFile);
      await fs.symlink(target, fixture.paths.credentialVaultFile);
      await assert.rejects(
        SqliteAuthState.open(fixture.state, fixture.masterKeyStore),
        hasCode("unsafe_state_path"),
      );
    }
  } finally {
    await auth?.close();
    await fixture.cleanup();
  }
});

test("failed purge key retirement keeps its descriptor and succeeds on retry", async () => {
  const fixture = await temporaryState();
  let auth;
  try {
    await ensureStateOwnership(fixture.paths);
    auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    await auth.saveCreds({ registered: true });
    await auth.close();
    auth = undefined;
    fixture.state.close();

    const descriptor = await fs.readFile(fixture.paths.credentialVaultFile, "utf8");
    const deleteKey = fixture.masterKeyStore.delete.bind(fixture.masterKeyStore);
    let attempts = 0;
    fixture.masterKeyStore.delete = async (...args) => {
      attempts += 1;
      if (attempts === 1) return false;
      return deleteKey(...args);
    };

    await assert.rejects(
      purgeLocalState(fixture.paths, { masterKeyStore: fixture.masterKeyStore }),
      hasCode("credential_cleanup_incomplete"),
    );
    assert.equal(attempts, 1);
    assert.equal(fixture.masterKeyStore.keys.size, 1);
    assert.equal(await fs.readFile(fixture.paths.credentialVaultFile, "utf8"), descriptor);

    await purgeLocalState(fixture.paths, { masterKeyStore: fixture.masterKeyStore });
    assert.equal(attempts, 2);
    assert.equal(fixture.masterKeyStore.keys.size, 0);
    await assert.rejects(fs.access(fixture.paths.credentialVaultFile));
  } finally {
    await auth?.close();
    await fixture.cleanup();
  }
});

test("an ambiguous false key deletion never discards the retry descriptor", async () => {
  const fixture = await temporaryState();
  let auth;
  try {
    await ensureStateOwnership(fixture.paths);
    auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    await auth.saveCreds({ registered: true });
    await auth.close();
    auth = undefined;
    fixture.state.close();

    const descriptor = await fs.readFile(fixture.paths.credentialVaultFile, "utf8");
    fixture.masterKeyStore.keys.clear();
    fixture.masterKeyStore.delete = async () => false;
    const getCalls = fixture.masterKeyStore.getCalls;

    await assert.rejects(
      purgeLocalState(fixture.paths, { masterKeyStore: fixture.masterKeyStore }),
      hasCode("credential_cleanup_incomplete"),
    );
    assert.equal(fixture.masterKeyStore.getCalls, getCalls);
    assert.equal(await fs.readFile(fixture.paths.credentialVaultFile, "utf8"), descriptor);

    await purgeLocalState(fixture.paths, {
      abandonCredentialKey: true,
      masterKeyStore: fixture.masterKeyStore,
    });
    await assert.rejects(fs.access(fixture.paths.credentialVaultFile));
  } finally {
    await auth?.close();
    await fixture.cleanup();
  }
});

test("an accepted deletion that leaves a readable key fails read-back cleanup", async () => {
  const fixture = await temporaryState();
  let auth;
  try {
    await ensureStateOwnership(fixture.paths);
    auth = await SqliteAuthState.open(fixture.state, fixture.masterKeyStore);
    await auth.saveCreds({ registered: true });
    await auth.close();
    auth = undefined;
    fixture.state.close();

    const descriptor = await fs.readFile(fixture.paths.credentialVaultFile, "utf8");
    fixture.masterKeyStore.delete = async () => true;

    await assert.rejects(
      purgeLocalState(fixture.paths, { masterKeyStore: fixture.masterKeyStore }),
      hasCode("credential_cleanup_incomplete"),
    );
    assert.equal(fixture.masterKeyStore.keys.size, 1);
    assert.equal(await fs.readFile(fixture.paths.credentialVaultFile, "utf8"), descriptor);

    await purgeLocalState(fixture.paths, {
      abandonCredentialKey: true,
      masterKeyStore: fixture.masterKeyStore,
    });
    assert.equal(fixture.masterKeyStore.keys.size, 1);
    await assert.rejects(fs.access(fixture.paths.credentialVaultFile));
  } finally {
    await auth?.close();
    await fixture.cleanup();
  }
});

function flipBase64UrlCharacter(value) {
  assert.ok(value.length > 0);
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

function hasCode(code) {
  return (error) => error?.code === code;
}

async function readIfPresent(file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}
