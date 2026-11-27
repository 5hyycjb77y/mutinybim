"""Exercise the native install and project-backed upgrade in a disposable Docker context."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
from tempfile import TemporaryDirectory
import time
from urllib.error import URLError
from urllib.request import Request, urlopen
from uuid import UUID


DRILLS = Path(__file__).resolve().parent
ROOT = DRILLS.parents[2]
EDITOR = "http://127.0.0.1:3095"
AUTHORITY = "http://127.0.0.1:8080"
KEYCLOAK = "http://127.0.0.1:8180"
REALM = KEYCLOAK + "/realms/east-plant"
SUPABASE = "http://127.0.0.1:8065"
PROJECT = "00000000-0000-4000-a000-00000000d001"


def run(args, *, capture=False, data=None, cwd=None):
    result = subprocess.run([str(arg) for arg in args], check=True, text=True, input=data,
                            stdout=subprocess.PIPE if capture else None, cwd=cwd)
    return result.stdout.strip() if capture else None


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def fetch(url, body=None):
    request = Request(url, data=None if body is None else json.dumps(body).encode(),
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=5) as response:
        return json.load(response)


def ready(url, timeout=180):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            return fetch(url)
        except (OSError, URLError, ValueError):
            time.sleep(0.5)
    raise RuntimeError("Service did not become ready at " + url)


def private_json(path, value):
    with open(path, "x", opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
        json.dump(value, stream)
    return path


def project_args(args, project, file, overlay=None):
    flags = [args.docker, "compose", "-p", project, "-f", file]
    return flags if overlay is None else [*flags, "-f", overlay]


@contextmanager
def disposable(flags):
    try:
        yield
    except Exception:
        subprocess.run([*flags, "ps", "--all"])
        raise
    finally:
        run([*flags, "down", "--volumes", "--remove-orphans"])


def sql(flags, query):
    return run([*flags, "exec", "-T", "db", "psql", "-XAtq", "-U", "postgres", "-v", "ON_ERROR_STOP=1"],
               data=query, capture=True)


def images(args, flags):
    return {name: run([args.docker, "inspect", "--format", "{{.Image}}",
                       run([*flags, "ps", "-q", name], capture=True)], capture=True)
            for name in ("authority", "editor")}


def keycloak_overlay(tmp, password):
    client = "east-plant-review"
    secret = secrets.token_urlsafe(32)
    realm = {"realm": "east-plant", "enabled": True, "sslRequired": "none",
             "clients": [{"clientId": client, "secret": secret, "publicClient": False,
                          "protocol": "openid-connect", "standardFlowEnabled": True,
                          "directAccessGrantsEnabled": False, "redirectUris": [EDITOR + "/auth/native/callback"]}],
             "users": [{"username": name.lower(), "firstName": name, "lastName": "Plant",
                        "email": name.lower() + "@example.invalid", "emailVerified": True, "enabled": True,
                        "credentials": [{"type": "password", "value": password, "temporary": False}]}
                       for name in ("Mara", "Jules")]}
    return private_json(tmp / "keycloak.json", {
        "services": {
            "authority": {"environment": {"MUTINYBIM_OIDC_ISSUER": REALM, "MUTINYBIM_OIDC_CLIENT_ID": client,
                                          "MUTINYBIM_OIDC_CLIENT_SECRET": secret}},
            "db": {"ports": ["127.0.0.1:8180:8180"]},
            "review-issuer": {"image": "quay.io/keycloak/keycloak:26.8.2", "network_mode": "service:db",
                             "depends_on": ["db"], "command": ["start-dev", "--http-port=8180",
                                                              "--hostname=" + KEYCLOAK, "--import-realm"],
                             "configs": [{"source": "review-realm", "target": "/opt/keycloak/data/import/east-plant.json"}]}},
        "configs": {"review-realm": {"content": json.dumps(realm)}}})


def native(args, tmp, project):
    checked = {}
    saved_images = None
    for provider in ("demo", "keycloak"):
        password = "east-plant-local-demo" if provider == "demo" else secrets.token_urlsafe(24)
        overlay = None if provider == "demo" else keycloak_overlay(tmp, password)
        flags = project_args(args, project, ROOT / "compose.native.yml", overlay)
        with disposable(flags):
            run([*flags, "config", "--quiet"])
            run([*flags, "up", "-d", "--build" if provider == "demo" else "--no-build"])
            issuer = "http://127.0.0.1:9999" if provider == "demo" else REALM
            ready(issuer + "/.well-known/openid-configuration")
            ready(EDITOR + "/demo-config.json")
            ids = images(args, flags)
            if saved_images is not None:
                require(ids == saved_images, "The second issuer must use the original authority and editor images")
                run([*flags, "stop", "signin"])
            saved_images = ids
            run([*flags, "exec", "-T", "authority", "node", "-e",
                 "const fs=require('fs'); if (!fs.existsSync('db/native') || !fs.existsSync('db/migrations') || "
                 "fs.existsSync('drills/native-browser-provider.ts') || fs.existsSync('dev-provider.ts')) process.exit(1)"])
            output = args.output / provider
            config = private_json(tmp / (provider + "-browser.json"), {
                "issuerMode": provider, "issuerUrl": issuer, "editorOrigin": EDITOR,
                "dockerExecutable": args.docker, "dockerArgs": list(map(str, flags[1:])),
                "credentials": {name: {"username": name, "password": password} for name in ("mara", "jules")},
                "playwrightModule": args.playwright_module, "browserChannel": args.browser_channel,
                "outputDir": str(output)})
            run(["node", "--import", "tsx", DRILLS / "native-compose-browser.mjs", config], cwd=ROOT)
            checked[provider] = {"images": ids, "browser": json.loads((output / "receipt.json").read_text())}
    return checked


def hosted_overlay(tmp):
    key = json.loads(run(["node", "-e", "const c=require('node:crypto'); const p=c.generateKeyPairSync('ec',"
                          "{namedCurve:'P-256'}).privateKey; console.log(JSON.stringify(p.export({format:'jwk'})))"],
                         capture=True))
    key.update(kid="upgrade-fixture", alg="ES256", use="sig", key_ops=["sign", "verify"])
    password = secrets.token_urlsafe(32)
    host = """import { TestProjectAuthorizer } from "./src/auth/test-authorizer";
export function createModelServerHost({sql}) {
  return { name: "local-upgrade-check",
    signIn: {issuer: "http://127.0.0.1:8065/auth/v1", audience: "authenticated",
             jwksUrl: "http://review-auth:8055/.well-known/jwks.json"},
    authorizer: () => new TestProjectAuthorizer(sql) };
}"""
    return private_json(tmp / "hosted.json", {
        "services": {
            "authority": {"environment": {"MUTINYBIM_AUTHORIZER_MODULE": "./upgrade-host.ts"},
                          "configs": [{"source": "review-host", "target": "/app/services/bim-authority/upgrade-host.ts"}]},
            "review-auth-db": {"image": "postgres:17-bookworm", "environment": {"POSTGRES_PASSWORD": password},
                               "volumes": ["review-auth-data:/var/lib/postgresql/data"],
                               "configs": [{"source": "review-auth-init", "target": "/docker-entrypoint-initdb.d/00-auth.sql"}],
                               "healthcheck": {"test": ["CMD", "pg_isready", "-U", "postgres", "-h", "127.0.0.1"],
                                               "interval": "2s", "timeout": "3s", "retries": 30}},
            "review-auth": {"image": "supabase/gotrue:v2.198.0", "ports": ["127.0.0.1:8065:8055"],
                            "depends_on": {"review-auth-db": {"condition": "service_healthy"}},
                            "environment": {"GOTRUE_API_HOST": "0.0.0.0", "GOTRUE_API_PORT": "8055",
                                "API_EXTERNAL_URL": SUPABASE + "/auth/v1", "GOTRUE_SITE_URL": EDITOR,
                                "GOTRUE_DB_DRIVER": "postgres", "GOTRUE_DB_DATABASE_URL":
                                    "postgres://postgres:" + password + "@review-auth-db:5432/postgres",
                                "GOTRUE_JWT_SECRET": secrets.token_urlsafe(40), "GOTRUE_JWT_KEYS": json.dumps([key]),
                                "GOTRUE_JWT_AUD": "authenticated", "GOTRUE_JWT_DEFAULT_GROUP_NAME": "authenticated",
                                "GOTRUE_JWT_ISSUER": SUPABASE + "/auth/v1", "GOTRUE_EXTERNAL_EMAIL_ENABLED": "true",
                                "GOTRUE_MAILER_AUTOCONFIRM": "true"}}},
        "volumes": {"review-auth-data": {}},
        "configs": {"review-host": {"content": host}, "review-auth-init": {"content":
                    "create schema auth; alter role postgres set search_path to auth, public;"}}})


def identities(password, signup):
    def legacy(name):
        body = fetch("http://127.0.0.1:9999/token?name=" + name)
        return {"name": name, "id": str(UUID(body["user_id"])), "token": body["access_token"]}

    def hosted(name):
        body = {"email": name.lower() + "@example.com", "password": password}
        if signup:
            fetch(SUPABASE + "/signup", body)
        reply = fetch(SUPABASE + "/token?grant_type=password", body)
        return {"name": name, "id": str(UUID(reply["user"]["id"])), "token": reply["access_token"]}

    return {"legacy": (legacy("Avery"), legacy("Sam")), "hosted": (hosted("Iris"), hosted("Kai"))}


def exercise(people, start, existing):
    checks = {}
    for source, (member, outsider) in people.items():
        level = "upgrade-level-" + str(start + 1)
        fixture = {"member": member, "outsider": outsider, "revision": start, "existingLevels": list(existing), "level": level}
        result = run(["node", "--import", "tsx", DRILLS / "compose-project-access.mjs"], cwd=ROOT / "services/bim-authority",
                     data=json.dumps(fixture), capture=True)
        checks[source] = json.loads(result.splitlines()[-1])
        existing.append(level)
        start += 1
    return checks


def snapshot(flags, historical):
    shapes = {
        "ledger": "select version,name,checksum,how,applied_at from bim.schema_migrations where version in (" + historical + ") order by version",
        "people": "select id from auth.users order by id",
        "projects": "select * from public.projects order by id",
        "members": "select * from public.project_members order by project_id,user_id",
        "model": "select id,project_id,host_project_id,settings,revision,created_at from bim.models order by id",
        "elements": "select model_id,element_id,body from bim.elements order by model_id,element_id",
        "history": "select model_id,revision,body from bim.changesets order by model_id,revision",
        "policies": "select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies "
                    "where schemaname in ('public','bim','realtime') and tablename in "
                    "('models','elements','changesets','messages','project_members','projects') order by 1,2,3"}
    return {key: hashlib.sha256(sql(flags, query).encode()).hexdigest() for key, query in shapes.items()}


def upgrade(args, tmp, project):
    overlay = hosted_overlay(tmp)
    old = project_args(args, project, args.previous_checkout / "docker-compose.yml", overlay)
    new = project_args(args, project, ROOT / "docker-compose.yml", overlay)
    password = secrets.token_urlsafe(24)
    levels = []
    with disposable(new):
        run([*old, "up", "-d", "--build"])
        ready(SUPABASE + "/health")
        ready(AUTHORITY + "/health")
        users = identities(password, signup=True)
        sam = users["legacy"][1]["id"]
        iris, kai = (person["id"] for person in users["hosted"])
        require(sql(old, "select count(*) from public.project_members") == "4", "Expected all four original demo members")
        require(sql(old, f"delete from public.project_members where project_id='{PROJECT}' and user_id='{sam}' returning user_id")
                == sam, "The test project must start with Sam excluded")
        sql(old, f"insert into auth.users(id) values ('{iris}'),('{kai}'); "
                 f"insert into public.project_members(project_id,user_id) values ('{PROJECT}','{iris}');")
        before_access = exercise(users, 0, levels)
        historical = sql(old, "select string_agg(quote_literal(version),',' order by version) from bim.schema_migrations")
        count = int(sql(old, "select count(*) from bim.schema_migrations"))
        before = snapshot(old, historical)
        volume = project + "_mutinybim-db"
        def volume_created():
            return run([args.docker, "volume", "inspect", "--format", "{{.CreatedAt}}", volume], capture=True)
        original_volume = volume_created()
        run([*old, "down"])
        run([*new, "up", "-d", "--build"])
        ready(SUPABASE + "/health")
        ready(AUTHORITY + "/health")
        require(volume_created() == original_volume, "Upgrade must use the original Docker volume")
        after = snapshot(new, historical)
        for key in before:
            require(before[key] == after[key], "Upgrade changed " + key)
        total = int(sql(new, "select count(*) from bim.schema_migrations"))
        require(total == count + 2, "Expected the two additive #36 migrations")
        require(sql(new, "select mode from bim.installation where id") == "hosted", "Expected the hosted installer")
        require(sql(new, "select permission_source from bim.model_authority where model_id='demo'") == "project",
                "The existing model should still use project membership")
        require(sql(new, "select count(*) from bim.model_members") == "0", "Unexpected native grants on upgraded project")
        after_access = exercise(identities(password, signup=False), 2, levels)
        require(sql(new, "select revision from bim.models where id='demo'") == "4", "Missing committed changes")
        return {"sameVolume": True, "originalMigrations": count, "finalMigrations": total, "preserved": before,
                "supabaseAuthImage": "supabase/gotrue:v2.198.0", "before": before_access, "after": after_access,
                "finalRevision": 4, "permissionSource": "project", "nativeModelGrants": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--previous-checkout", type=Path, help="Unmodified checkout of the pre-#36 upstream installation")
    parser.add_argument("--only", choices=("native", "upgrade"), help="Run one part of the walkthrough")
    parser.add_argument("--docker", default="docker")
    parser.add_argument("--playwright-module", default="playwright")
    parser.add_argument("--browser-channel", default=None)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    # The walkthrough exercises the documented local defaults and its own test issuers.
    os.environ["COMPOSE_DISABLE_ENV_FILE"] = "true"
    for name in ("MUTINYBIM_DEMO_PASSWORD", "MUTINYBIM_OIDC_ISSUER", "MUTINYBIM_OIDC_CLIENT_ID", "MUTINYBIM_OIDC_CLIENT_SECRET"):
        os.environ.pop(name, None)
    if args.only != "native":
        if args.previous_checkout is None or not (args.previous_checkout / "docker-compose.yml").is_file():
            parser.error("Supply --previous-checkout with the pre-#36 docker-compose.yml")
        args.previous_checkout = args.previous_checkout.resolve()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    require(not (args.output / "results.json").exists(), "Use a new results directory")
    results = {"composeVersion": run([args.docker, "compose", "version", "--short"], capture=True)}
    project = "bim36-" + secrets.token_hex(6)
    with TemporaryDirectory(prefix="bim36-compose-") as td:
        tmp = Path(td)
        for name, check in (("native", native), ("upgrade", upgrade)):
            if args.only is None or args.only == name:
                results[name] = check(args, tmp, project + "-" + name)
                (args.output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
                print(name + " passed", flush=True)


if __name__ == "__main__":
    main()
