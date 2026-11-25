#!/usr/bin/env python3
"""Sincroniza el árbol del bot con el servidor Nodaroo.

Uso local:
    python3 sync_host.py [--source DIR] [--dry-run] [--restart] [--delete-extras]

Uso en GitHub Actions (ver .github/workflows/sync-host.yml):
    NODAROO_API_KEY=<clave del panel> NODAROO_SERVER_ID=c82ff6fe \
        python3 scripts/sync_host.py --source . --restart

- Acepta el árbol en layout viejo (raíz: index.js, cmds/, lib/) o en layout
  bot/ (bot/index.js + start.js). Si es layout viejo, construye la
  reorganización en un temporal (mover código a bot/, start.js,
  package.json con imports ./bot/..., ping.js con BOT_ROOT, .gitignore
  bot/...) antes de comparar. Es la misma reorganización del fix del
  glob de Pterodactyl (un solo .js en la raíz: start.js).
- Compara con el servidor por tamaño y sube solo los archivos nuevos o
  cambiados (204 por archivo).
- NUNCA toca los datos del bot en el servidor: bot/.env, bot/Sessions/,
  bot/lib/system/botstore.json ni bot/lib/system/tmp/ (contadores, sesión
  de WhatsApp, estado de crunchyroll-notify, etc.).
- NUNCA sube package-lock.json: el del servidor ya incluye yt-search y lo
  que npm install resuelva; el lock de main no lo tiene.
- .gitignore solo se sube si el local trae reglas que el del servidor no
  tiene (el del servidor es un superset con reglas lib/ y bot/).
- Los archivos que sobran en el servidor (no son datos del bot) solo se
  listan; se borran únicamente con --delete-extras.
- Con --restart reinicia el bot y espera a que vuelva a running (el
  endpoint de estado a veces da 503 "temporarily busy", reintenta solo).

Autenticación (en este orden):
  1. Variable NODAROO_API_KEY (clave de cliente del panel, ptlc_...).
  2. Conector custom.nodaroo de Muse (dynamic_credentials).
"""
import argparse
import json
import os
import pathlib
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
    from dynamic_credentials import add_surrogate_to_request, read_json_response
    DYNAMIC_AVAILABLE = True
except Exception:
    DYNAMIC_AVAILABLE = False

PANEL = "https://panel.nodaroo.com"
SERVER_ID = os.environ.get("NODAROO_SERVER_ID", "c82ff6fe")
DEFAULT_SOURCE = "/home/hatch/workspace/RemBot-MD-reorg-v2"

# Rutas locales que nunca se suben (el .git del worktree es un puntero;
# .github y scripts/ son herramientas del repo, no código del bot).
LOCAL_SKIP = {".git", "package-lock.json"}
LOCAL_SKIP_PREFIXES = (".github/", "scripts/")
# Rutas del servidor que nunca se tocan (datos del bot, no código).
SERVER_KEEP_PREFIXES = ("bot/.env", "bot/Sessions/", "bot/lib/system/botstore.json",
                        "bot/lib/system/tmp/")
SERVER_SKIP_DIRS = {"node_modules", ".git", "Sessions", ".npm"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused")


def add_auth(req):
    key = os.environ.get("NODAROO_API_KEY")
    if key:
        req.add_header("Authorization", "Bearer " + key)
        return
    if DYNAMIC_AVAILABLE:
        add_surrogate_to_request(req, "custom.nodaroo", allowed_hosts=["panel.nodaroo.com"])
        return
    raise RuntimeError(
        "Falta la clave del panel: define NODAROO_API_KEY o usa el conector "
        "custom.nodaroo. La clave se crea en panel.nodaroo.com > Account > API Credentials.")


def api(method, path, data=None, ct="application/json"):
    req = urllib.request.Request(PANEL + path, data=data, method=method)
    req.add_header("Accept", "application/json")
    req.add_header("Content-Type", ct)
    req.add_header("User-Agent", "curl/8.5.0")
    add_auth(req)
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=60) as r:
        return r.status, r.read().decode()


def list_dir(directory):
    _, body = api("GET", f"/api/client/servers/{SERVER_ID}/files/list"
                  f"?directory={urllib.parse.quote(directory)}")
    return json.loads(body)


def server_tree():
    """Mapa ruta -> tamaño de todos los archivos del servidor (sin node_modules/.git/Sessions/.npm)."""
    out = {}

    def walk(directory):
        for entry in list_dir(directory).get("data", []):
            attr = entry["attributes"]
            path = (directory.rstrip("/") + "/" + attr["name"]).lstrip("/")
            if attr["is_file"]:
                out[path] = attr["size"]
            elif attr["name"] not in SERVER_SKIP_DIRS:
                walk(path)

    walk("/")
    return out


def build_source_tree(source):
    """Devuelve (árbol a sincronizar, temporal a borrar o None).

    Si el origen ya tiene layout bot/ se usa tal cual; si tiene layout
    viejo se construye la reorganización en un temporal.
    """
    source = pathlib.Path(source)
    if (source / "bot" / "index.js").is_file() and (source / "start.js").is_file():
        return source, None
    if not (source / "index.js").is_file():
        raise RuntimeError(f"El origen {source} no tiene ni layout bot/ ni index.js en la raíz.")
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="rembot-reorg-"))
    shutil.copytree(source, tmp, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(".git", "node_modules"))
    bot = tmp / "bot"
    bot.mkdir(exist_ok=True)
    for name in ["index.js", "handler.js", "settings.js", "cmds", "lib", "assets", ".env.example"]:
        item = tmp / name
        if item.exists():
            shutil.move(str(item), str(bot / name))
    (tmp / "start.js").write_text("process.chdir('./bot');\nawait import('./bot/index.js');\n")
    pkg_path = tmp / "package.json"
    pkg = json.loads(pkg_path.read_text())
    pkg["main"] = "start.js"
    pkg["scripts"] = {"start": "node start.js", "start:qr": "node start.js --qr"}
    pkg["imports"] = {k: v.replace("./", "./bot/", 1)
                      for k, v in pkg.get("imports", {}).items()}
    pkg_path.write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + "\n")
    ping = bot / "cmds" / "ping.js"
    if ping.is_file():
        text = ping.read_text()
        text = text.replace(
            "const REPO_ROOT = path.resolve(__dirname, '..')",
            "const REPO_ROOT = path.resolve(__dirname, '..', '..')\n"
            "const BOT_ROOT = path.resolve(__dirname, '..')")
        text = text.replace(
            "const IMAGE_PATH = path.join(REPO_ROOT, 'assets', 'rem-host.png')",
            "const IMAGE_PATH = path.join(BOT_ROOT, 'assets', 'rem-host.png')")
        text = text.replace(
            "const exifTempRoot = path.join(REPO_ROOT, 'lib', 'system', path.basename(tempRoot))",
            "const exifTempRoot = path.join(BOT_ROOT, 'lib', 'system', path.basename(tempRoot))")
        ping.write_text(text)
    gitignore = tmp / ".gitignore"
    if gitignore.is_file():
        text = gitignore.read_text()
        text = text.replace("lib/system/tmp/*", "bot/lib/system/tmp/*")
        text = text.replace("lib/system/botstore.json", "bot/lib/system/botstore.json")
        gitignore.write_text(text)
    return tmp, tmp


def local_tree(source):
    root = pathlib.Path(source)
    out = {}
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = str(path.relative_to(root))
        if rel in LOCAL_SKIP or ".git/" in rel or "node_modules" in rel:
            continue
        if rel.startswith(LOCAL_SKIP_PREFIXES) or rel.startswith(SERVER_KEEP_PREFIXES):
            continue
        out[rel] = path.stat().st_size
    return out


def server_file_text(path):
    _, body = api("GET", f"/api/client/servers/{SERVER_ID}/files/contents"
                  f"?file={urllib.parse.quote('/' + path)}")
    return body


def wait_running(retries=8, delay=15):
    for _ in range(retries):
        try:
            _, body = api("GET", f"/api/client/servers/{SERVER_ID}/resources")
            attrs = json.loads(body)["attributes"]
            if attrs["current_state"] == "running":
                return True, attrs["resources"]["uptime"]
        except Exception:
            pass  # 503 "temporarily busy" o timeout: reintentar
        time.sleep(delay)
    return False, 0


def main():
    parser = argparse.ArgumentParser(description="Sincroniza el bot local con Nodaroo.")
    parser.add_argument("--source", default=DEFAULT_SOURCE,
                        help="árbol local (layout viejo o bot/; por defecto reorg-v2)")
    parser.add_argument("--dry-run", action="store_true",
                        help="solo muestra lo que haría, sin subir nada")
    parser.add_argument("--restart", action="store_true",
                        help="reinicia el bot al terminar y verifica que vuelva a running")
    parser.add_argument("--delete-extras", action="store_true",
                        help="borra archivos del servidor que no están en local (nunca datos del bot)")
    args = parser.parse_args()

    source = pathlib.Path(args.source)
    if not source.is_dir():
        print(f"ERROR: no existe el árbol local {source}")
        return 2

    try:
        tree, tmpdir = build_source_tree(source)
    except RuntimeError as exc:
        print(f"ERROR: {exc}")
        return 2
    if tmpdir is not None:
        print(f"Origen en layout viejo: reorganización construida en {tmpdir}")

    print(f"Origen: {source}")
    print("Comparando con el servidor...")
    try:
        server = server_tree()
    except Exception as exc:
        print(f"ERROR: no se pudo leer el servidor: {exc}")
        return 1
    local = local_tree(tree)

    to_upload = []
    for rel, size in sorted(local.items()):
        if rel == ".gitignore":
            # Solo subir si el local trae reglas que el servidor no tiene.
            try:
                server_lines = set(server_file_text(rel).splitlines())
                local_lines = set((tree / rel).read_text().splitlines())
                if local_lines <= server_lines:
                    continue
            except Exception:
                pass  # si no se puede leer, subirlo
        if rel not in server or server[rel] != size:
            to_upload.append(rel)

    extras = [rel for rel in sorted(server)
              if rel not in local
              and rel != "package-lock.json"  # el del servidor tiene yt-search; nunca borrarlo
              and not rel.startswith(SERVER_KEEP_PREFIXES)
              and not rel.startswith((".git/", "node_modules/", ".npm/"))]

    print(f"Servidor: {len(server)} archivos, local: {len(local)} archivos")
    print(f"A subir/actualizar: {len(to_upload)}")
    for rel in to_upload:
        print(f"  ↑ {rel} ({local[rel]} bytes)")
    print(f"Extras en servidor (no son datos del bot): {len(extras)}")
    for rel in extras:
        print(f"  ? {rel}")

    exit_code = 0
    if args.dry_run:
        print("Dry-run: no se subió nada.")
    elif not to_upload and not (args.delete_extras and extras):
        print("Todo en sync, nada que subir.")
    else:
        failed = []
        for rel in to_upload:
            content = (tree / rel).read_bytes()
            try:
                status, _ = api("POST", f"/api/client/servers/{SERVER_ID}/files/write"
                                f"?file={urllib.parse.quote('/' + rel)}",
                                content, "text/plain")
                print(f"  subido /{rel}: {status}")
                if status != 204:
                    failed.append(rel)
            except Exception as exc:
                print(f"  ERROR /{rel}: {exc}")
                failed.append(rel)
        if args.delete_extras and extras:
            by_dir = {}
            for rel in extras:
                directory, name = rel.rsplit("/", 1) if "/" in rel else ("/", rel)
                by_dir.setdefault("/" + directory if directory else "/", []).append(name)
            for directory, names in by_dir.items():
                try:
                    status, _ = api("POST", f"/api/client/servers/{SERVER_ID}/files/delete",
                                    json.dumps({"root": directory, "files": names}).encode())
                    print(f"  borrados en {directory}: {names} -> {status}")
                except Exception as exc:
                    print(f"  ERROR borrando en {directory}: {exc}")
                    failed.extend(f"{directory}/{n}" for n in names)
        if failed:
            print(f"Fallaron {len(failed)} archivos: {failed}")
            exit_code = 1
        else:
            print("Sincronización completa.")

    if args.restart and exit_code == 0:
        print("Reiniciando el bot...")
        try:
            api("POST", f"/api/client/servers/{SERVER_ID}/power",
                json.dumps({"signal": "restart"}).encode())
        except Exception as exc:
            print(f"ERROR: no se pudo reiniciar: {exc}")
            exit_code = 1
        else:
            ok, uptime = wait_running()
            if ok:
                print(f"Bot en running (uptime {uptime} ms).")
            else:
                print("AVISO: el bot no confirmó running tras el reinicio; revisa el panel.")
                exit_code = 1

    if tmpdir is not None:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
