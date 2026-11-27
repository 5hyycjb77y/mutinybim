"""Exercise the shipping --native migration CLI on a fresh, disposable PostgreSQL cluster."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.error import URLError
from urllib.request import urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pg-bin", type=Path, help="directory containing the PostgreSQL server and client tools")
    parser.add_argument("--browser", action="store_true", help="exercise two Chromium profiles on the native editor and restart the authority")
    parser.add_argument("--playwright-module", default="playwright", help="Playwright package or absolute path to its JS entry")
    parser.add_argument("--browser-channel", default="", help="use an installed Playwright browser channel, such as chrome")
    parser.add_argument("--screenshots", type=Path, help="save the owner and viewer screenshots in this directory")
    args = parser.parse_args()
    tools = {}
    for name in ("initdb", "pg_ctl", "psql"):
        binary = shutil.which(str(args.pg_bin / name) if args.pg_bin else name)
        if not binary:
            parser.exit(2, f"Missing {name}. Supply --pg-bin with a PostgreSQL 17 installation.\n")
        tools[name] = binary

    authority = Path(__file__).resolve().parents[1]
    node = shutil.which("node")
    if not node:
        parser.exit(2, "Node 22 or later is required.\n")
    # A developer's hosted database, credentials and Fly configuration must never enter this drill.
    env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "TMPDIR") if k in os.environ}
    password = secrets.token_hex(24)
    with tempfile.TemporaryDirectory(prefix="bim-native-install-") as tmp:
        root = Path(tmp)
        cluster = root / "pgdata"
        pwfile = root / "password"
        pwfile.write_text(password + "\n")
        pwfile.chmod(0o600)
        subprocess.run([tools["initdb"], "-D", cluster, "-U", "cluster_admin", "--auth-host=scram-sha-256",
                        "--auth-local=trust", f"--pwfile={pwfile}", "--no-locale", "-E", "UTF8"], env=env, check=True)
        def loopback_port():
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                return probe.getsockname()[1]

        port = loopback_port()
        # Disable Unix sockets. The cluster is reachable only on its own loopback port.
        start = [tools["pg_ctl"], "-w", "-D", cluster, "-l", root / "postgres.log",
                 "-o", f"-h 127.0.0.1 -p {port} -c unix_socket_directories=''", "start"]
        stop = [tools["pg_ctl"], "-w", "-D", cluster, "-m", "fast", "stop"]
        pg_env = dict(env, PGHOST="127.0.0.1", PGPORT=str(port), PGUSER="operator",
                      PGPASSWORD=password, PGDATABASE="native_drill")
        admin_env = dict(pg_env, PGUSER="cluster_admin", PGDATABASE="postgres")
        db_url = f"postgresql://operator:{password}@127.0.0.1:{port}/native_drill"
        cli_env = dict(env, MUTINYBIM_DB_URL=db_url)

        def sql(query, env_override=None):
            return subprocess.check_output([tools["psql"], "-XAtq", "-v", "ON_ERROR_STOP=1"],
                                           env=env_override or pg_env, text=True, input=query).strip()

        def migrate(*flags, target=cli_env):
            subprocess.run([node, "--import", "tsx", "src/migrate.ts", "--native", *flags],
                           cwd=authority, env=target, check=True)

        def drill(script, *args):
            result = subprocess.check_output([node, "--import", "tsx", f"drills/{script}.ts", *args],
                                             cwd=authority, env=dict(env, MUTINYBIM_NATIVE_DRILL_URL=db_url),
                                             text=True, timeout=60)
            return json.loads(result.strip().splitlines()[-1])

        def check(condition, message):
            if not condition:
                raise RuntimeError(message)

        model_id = "east-plant"
        session_file = root / "drill-sessions.json"

        def exercise_live_authority():
            ws_port = loopback_port()
            instance = "east-plant-drill-" + secrets.token_hex(8)
            server_env = dict(cli_env, MUTINYBIM_AUTH_MODE="native", MUTINYBIM_LOCAL_STACK="1",
                              BIM_AUTHORITY_SERVED_MODELS=model_id, BIM_AUTHORITY_BIND_HOST="127.0.0.1",
                              BIM_AUTHORITY_REAUTH_MS="1000", BIM_AUTHORITY_COMMIT=instance, PORT=str(ws_port))
            with (root / "authority.log").open("w+") as log:
                server = subprocess.Popen([node, "--import", "tsx", "src/server.ts"], cwd=authority,
                                          env=server_env, stdout=log, stderr=subprocess.STDOUT)
                try:
                    deadline = time.monotonic() + 45
                    while server.poll() is None and time.monotonic() < deadline:
                        try:
                            with urlopen(f"http://127.0.0.1:{ws_port}/health", timeout=1) as response:
                                if json.load(response).get("commit") == instance:
                                    break
                        except (URLError, TimeoutError):
                            pass
                        time.sleep(0.1)
                    else:
                        raise RuntimeError("The native authority did not become ready")
                    return drill("native-live-sockets", str(ws_port), session_file)
                except Exception:
                    log.seek(0)
                    print(log.read(), flush=True)
                    raise
                finally:
                    if server.poll() is None:
                        server.terminate()
                        try:
                            server.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            server.kill()
                            server.wait()

        def create_model(person, model=model_id):
            return subprocess.run([node, "--import", "tsx", "src/create-native-model.ts", model, "--owner", person],
                                  cwd=authority, env=cli_env, capture_output=True, text=True)

        def provision_first_owner(owner, other):
            missing = create_model("00000000-0000-4000-a000-000000000036")
            check(missing.returncode != 0 and "existing native person" in missing.stderr,
                  "Expected a missing person to be refused: " + missing.stderr)
            check(sql("select count(*) from bim.models") == "0", "A missing person left a model")
            with ThreadPoolExecutor(max_workers=2) as pool:
                attempts = list(pool.map(create_model, [owner, owner]))
            check(all(result.returncode == 0 for result in attempts), "Concurrent creation failed: " +
                  " ".join(result.stderr for result in attempts))
            check(sum("Created model" in result.stdout for result in attempts) == 1 and
                  sum("already exists with this owner" in result.stdout for result in attempts) == 1,
                  "Expected one creation and one confirmation")
            conflict = create_model(other)
            check(conflict.returncode != 0 and "already in use" in conflict.stderr, "Expected a different owner to be refused")
            child = create_model(owner, model_id + "~child")
            check(child.returncode != 0 and "base model ID" in child.stderr, "Expected a copy ID to be refused")
            check(sql("select count(*) from bim.models") == "1" and
                  sql("select person_id, role from bim.model_members") == f"{owner}|manager",
                  "Expected exactly one model and its designated owner's manager grant")
            print("Operator command created one model, confirmed a retry and refused a conflicting owner.", flush=True)

        def check_nonempty_targets():
            cases = [
                ("schema", "create schema field_notes", "drop schema field_notes"),
                ("collation", 'create collation public.field_sort from pg_catalog."C"', "drop collation public.field_sort"),
            ]
            accepted = []
            for kind, create, remove in cases:
                sql(create)
                try:
                    result = subprocess.run([node, "--import", "tsx", "src/migrate.ts", "--native", "--dry-run"],
                                            cwd=authority, env=cli_env, text=True, capture_output=True)
                    if result.returncode == 0:
                        accepted.append(kind)
                    else:
                        check("requires an empty" in result.stderr, f"Unexpected refusal for existing {kind}: {result.stderr}")
                finally:
                    sql(remove)
            check(not accepted, f"Installer treated existing application objects as an empty database: {accepted}")
            print("Refused the existing schema and collation on separate runs.", flush=True)

        def check_interrupted_install():
            sql("create database installer_recovery owner operator", admin_env)
            target = dict(cli_env, MUTINYBIM_DB_URL=db_url.rsplit("/", 1)[0] + "/installer_recovery")
            recovery_pg = dict(pg_env, PGDATABASE="installer_recovery")
            # A first attempt can stop after this production call and before its first SQL file commits.
            prepare_ledger = """
                const { connectForMigrations, pgMigrationSession } = require("./src/pg-migration-session.ts");
                const sql = connectForMigrations(process.env.MUTINYBIM_DB_URL);
                pgMigrationSession(sql).createTrackingTable().finally(() => sql.end());
            """
            subprocess.run([node, "--import", "tsx", "--eval", prepare_ledger], cwd=authority, env=target, check=True)
            check(sql("select count(*) from bim.schema_migrations", recovery_pg) == "0", "Expected an empty ledger")
            migrate("--dry-run", target=target)
            check(sql("select to_regclass('bim.installation') is null", recovery_pg) == "t", "Dry run installed the baseline")
            migrate(target=target)
            check(sql("select mode from bim.installation where id", recovery_pg) == "native", "Recovery did not finish")
            print("Recovered an interrupted first install from the stock empty ledger.", flush=True)

        def dry_run():
            # New connections made by the real CLI must be able to complete this
            # step even when PostgreSQL itself rejects writes.
            sql("alter role operator set default_transaction_read_only = on", admin_env)
            try:
                check(sql("show default_transaction_read_only") == "on", "Read-only session setting missing")
                migrate("--dry-run")
            finally:
                sql("alter role operator reset default_transaction_read_only", admin_env)

        manifest = """select version, name, checksum, how, applied_at from bim.schema_migrations order by version"""
        # Include objects in public so a dry run cannot hide side effects outside the authority schema.
        objects = """select nspname, relname, relkind from pg_class join pg_namespace on relnamespace = pg_namespace.oid
                     where nspname !~ '^pg_' and nspname <> 'information_schema' order by 1, 2, 3"""
        subprocess.run(start, env=env, check=True)
        try:
            sql(f"create role operator login password '{password}'", admin_env)
            sql("create database native_drill owner operator", admin_env)
            check(sql("select current_setting('server_version_num')::int / 10000") == "17",
                  "Supply a PostgreSQL 17 server for this drill")
            original = sql(objects)
            check_nonempty_targets()
            check_interrupted_install()
            dry_run()
            check(original == sql(objects) and sql("select to_regnamespace('bim') is null") == "t",
                  "Dry run created database objects")
            migrate()
            if args.browser:
                subprocess.run([node, "--import", "tsx", "drills/native-browser-walkthrough.mjs", str(root),
                                args.playwright_module, str(loopback_port()), str(loopback_port()), str(loopback_port()),
                                str(args.screenshots.resolve()) if args.screenshots else "", args.browser_channel],
                               cwd=authority, env=dict(env, MUTINYBIM_NATIVE_DRILL_URL=db_url), check=True)
                return
            for table in ("models", "elements", "changesets", "lineages", "lineage_members"):
                check(sql(f"select to_regclass('bim.{table}') is not null") == "t", f"Missing bim.{table}")
            check(sql("select to_regclass('public.projects') is null and to_regnamespace('auth') is null") == "t",
                  "Native installation created hosted dependencies")
            check(sql("select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')") == "0",
                  "Native installation created hosted API roles")
            ledger = sql(manifest)
            check(bool(ledger), "Native installation did not record a migration")
            installed = sql(objects)
            people = drill("native-install-sessions", "issue", session_file)
            check(people["owner"] != people["coworker"] and sql("select count(*) from bim.people") == "2",
                  "Expected two people from the verified fixture identities")
            check(sql("select count(*) from bim.model_members") == "0", "Signing in granted a model role")
            provision_first_owner(people["owner"], people["coworker"])
            heads = drill("native-install-model", "write", model_id, people["owner"])
            grants = drill("native-install-members", "grant", model_id, session_file)
            check(grants["owner"] == "manager" and grants["coworker"] == "viewer", "Viewer grant failed")
            previous_start = sql("select pg_postmaster_start_time()")
            subprocess.run(stop, env=env, check=True)
            subprocess.run(start, env=env, check=True)
            check(previous_start != sql("select pg_postmaster_start_time()"), "PostgreSQL did not restart")
            migrate()
            dry_run()
            check(ledger == sql(manifest) and installed == sql(objects), "Rerun changed the schema or migration ledger")
            reopened = drill("native-install-sessions", "reopen", session_file)
            check(reopened["owner"] == people["owner"], "The active session resolved to a different person")
            retry = create_model(reopened["owner"])
            check(retry.returncode == 0 and "already exists with this owner" in retry.stdout,
                  "Expected a repeat after restart to confirm the original owner")
            check(heads == drill("native-install-model", "reopen", model_id, reopened["owner"]),
                  "Model, copy or ownership changed after restart")
            check(set(sql("select person_id, role from bim.model_members").splitlines()) ==
                  {f"{people['owner']}|manager", f"{people['coworker']}|viewer"},
                  "Sign-in or restart changed the designated memberships")
            check(grants == drill("native-install-members", "reopen", model_id, session_file),
                  "The hub walkthrough changed the recorded roles or authorization revision")
            print("East plant reopened after restart. The hub welcomed both people, refused the viewer's edit "
                  "and saved the owner's East roof level. The coworker's revoked and expired sessions stayed closed.")
            live = exercise_live_authority()
            check(live["before"] == heads["model"][1] + 1 and live["saved"] == live["before"] + 1
                  and live["viewerSaw"] == live["saved"] and live["viewerWrite"] == "forbidden",
                  "The two live clients and the durable East plant model did not agree")
            print(f"East plant live WebSockets: both clients opened revision {live['before']}. "
                  f"The owner's Service deck reached the viewer and PostgreSQL at revision {live['saved']}. "
                  "The viewer write was refused. Revocation and expiry closed only the affected sessions.")
            print(f"Native install, restart and rerun passed with {len(ledger.splitlines())} recorded migrations. "
                  f"Reopened model revision {heads['model'][1]} and copy revision {heads['copy'][1]} with matching hashes.")
        finally:
            if (cluster / "postmaster.pid").exists():
                subprocess.run(stop, env=env, check=True)


if __name__ == "__main__":
    main()
