#!/usr/bin/env python3
"""通过 GitHub Contents API 上传目录文件（绕过 git 协议）。

用法：
  GH_TOKEN=... REPO=owner/name SRC_DIR=/path/to/dir DEST_PREFIX= \
    python3 eval/gh-api-upload.py

说明：
  - 仅使用 api.github.com（当 github.com:443 不可达时仍可用）
  - 已存在文件会自动带上 sha 更新（幂等，可重复执行）
  - 令牌只从环境变量读取，不写入任何文件
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

TOKEN = os.environ.get("GH_TOKEN", "")
REPO = os.environ.get("REPO", "")
SRC_DIR = os.environ.get("SRC_DIR", ".")
DEST_PREFIX = os.environ.get("DEST_PREFIX", "").strip("/")
BRANCH = os.environ.get("BRANCH", "main")
MESSAGE = os.environ.get("COMMIT_MSG", "chore: upload via Contents API")

API = "https://api.github.com"

# 排除规则
SKIP_DIRS = {".git", "node_modules"}
SKIP_FILES = {".DS_Store"}


def req(method, path, payload=None):
    url = f"{API}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Accept", "application/vnd.github+json")
    r.add_header("Authorization", f"Bearer {TOKEN}")
    r.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            body = resp.read().decode()
            return resp.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {"message": body[:300]}
        return e.code, parsed


def get_sha(path):
    """取已存在文件的 blob sha；不存在返回 None。"""
    code, data = req("GET", f"/repos/{REPO}/contents/{path}?ref={BRANCH}")
    if code == 200 and isinstance(data, dict):
        return data.get("sha")
    return None


def collect_files(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if fn in SKIP_FILES:
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            out.append((rel, full))
    return sorted(out)


def main():
    if not TOKEN or not REPO:
        print("缺少 GH_TOKEN / REPO")
        sys.exit(1)

    files = collect_files(SRC_DIR)
    print(f"待上传 {len(files)} 个文件 → {REPO} (branch={BRANCH})")

    ok = fail = 0
    for rel, full in files:
        dest = f"{DEST_PREFIX}/{rel}" if DEST_PREFIX else rel
        with open(full, "rb") as f:
            content = base64.b64encode(f.read()).decode()

        payload = {"message": f"{MESSAGE}: {dest}", "content": content, "branch": BRANCH}
        sha = get_sha(dest)
        if sha:
            payload["sha"] = sha

        code, data = req("PUT", f"/repos/{REPO}/contents/{dest}", payload)
        if code in (200, 201):
            ok += 1
            print(f"  OK   {dest}")
        else:
            fail += 1
            print(f"  FAIL {dest} → {code} {data.get('message', '')[:120]}")
        time.sleep(0.35)  # 温和限速，避免触发二级限流

    print(f"\n完成：成功 {ok}，失败 {fail}")
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
