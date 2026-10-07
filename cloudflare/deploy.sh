#!/usr/bin/env bash
# ClaudeVoice 一键部署到 Cloudflare，并自动切换 Claude/Mac App 配置。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
cd "$SCRIPT_DIR"

read_env() {
  local key="$1" line value
  line="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 || true)"
  value="${line#*=}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

put_secret() {
  local name="$1" value="$2"
  [ -n "$value" ] || return 0
  printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null
  echo "  ✓ $name"
}

echo "== 检查环境 =="
[ -f "$ENV_FILE" ] || { echo "✗ 找不到 $ENV_FILE，请先在仓库根目录运行 node setup.js"; exit 1; }
npx wrangler whoami >/dev/null 2>&1 || { echo "✗ 还没登录，请先运行：cd \"$SCRIPT_DIR\" && npx wrangler login"; exit 1; }

HOOKSEC="$(read_env HOOK_SECRET)"
[ -n "$HOOKSEC" ] || { echo "✗ .env 没有 HOOK_SECRET，请先在仓库根目录运行 node setup.js"; exit 1; }
DASH="${DASH_TOKEN:-$(read_env DASH_TOKEN)}"
[ -n "$DASH" ] || DASH="$(openssl rand -hex 16)"
SUBJECT="${VAPID_SUBJECT:-mailto:you@example.com}"

echo "== 生成 VAPID 密钥（Web Push）=="
VAPID="$(node -e 'const {webcrypto:c}=require("crypto");(async()=>{const kp=await c.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);const b=x=>Buffer.from(x).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");const pub=b(await c.subtle.exportKey("raw",kp.publicKey));const priv=JSON.stringify(await c.subtle.exportKey("jwk",kp.privateKey));process.stdout.write(pub+"\n"+priv);})();')"
VPUB="$(printf '%s\n' "$VAPID" | sed -n '1p')"
VPRIV="$(printf '%s\n' "$VAPID" | sed -n '2p')"

echo "== 首次部署（创建或更新 Worker）=="
npx wrangler deploy

echo "== 设置 secrets =="
put_secret HOOK_SECRET "$HOOKSEC"
put_secret DASH_TOKEN "$DASH"
put_secret VAPID_PUBLIC "$VPUB"
put_secret VAPID_PRIVATE "$VPRIV"
put_secret VAPID_SUBJECT "$SUBJECT"

# Azure 可选兜底
put_secret AZURE_SPEECH_KEY "$(read_env AZURE_SPEECH_KEY)"
put_secret AZURE_SPEECH_REGION "$(read_env AZURE_SPEECH_REGION)"

# 飞书机器人私信凭证（从项目 .env 复用）
put_secret LARK_APP_ID "$(read_env LARK_APP_ID)"
put_secret LARK_APP_SECRET "$(read_env LARK_APP_SECRET)"
put_secret LARK_OPEN_ID "$(read_env LARK_OPEN_ID)"
put_secret LARK_WEBHOOK_URL "${LARK_WEBHOOK_URL:-$(read_env LARK_WEBHOOK_URL)}"
put_secret LARK_WEBHOOK_SECRET "${LARK_WEBHOOK_SECRET:-$(read_env LARK_WEBHOOK_SECRET)}"
put_secret TELEGRAM_BOT_TOKEN "${TELEGRAM_BOT_TOKEN:-$(read_env TELEGRAM_BOT_TOKEN)}"
put_secret TELEGRAM_CHAT_ID "${TELEGRAM_CHAT_ID:-$(read_env TELEGRAM_CHAT_ID)}"

echo "== 最终部署并读取 Worker 地址 =="
WRANGLER_JSON="$(mktemp "${TMPDIR:-/tmp}/claudevoice-wrangler-output.XXXXXX")"
DEPLOY_LOG="$(mktemp "${TMPDIR:-/tmp}/claudevoice-wrangler-log.XXXXXX")"
cleanup() {
  rm -f -- "$WRANGLER_JSON" "$DEPLOY_LOG"
}
trap cleanup EXIT
WRANGLER_OUTPUT_FILE_PATH="$WRANGLER_JSON" FORCE_COLOR=0 npx wrangler deploy 2>&1 | tee "$DEPLOY_LOG"

WORKER_URL="$(node -e '
  const fs = require("fs");
  let found = "";
  for (const line of fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.type === "deploy" && Array.isArray(item.targets)) {
        const target = item.targets.find((value) => /^https:\/\/[^/]+\.workers\.dev\/?$/i.test(value));
        if (target) found = target;
      }
    } catch (_) {}
  }
  process.stdout.write(found.replace(/\/$/, ""));
' "$WRANGLER_JSON")"
if [ -z "$WORKER_URL" ]; then
  WORKER_URL="$(grep -Eo 'https://[A-Za-z0-9._-]+\.workers\.dev' "$DEPLOY_LOG" | tail -1 || true)"
fi
[ -n "$WORKER_URL" ] || { echo "✗ Worker 已部署，但无法从 Wrangler 输出解析 workers.dev 地址；未改写本机配置。"; exit 1; }

echo "== 自动备份并改写 ClaudeVoice 配置 =="
CV_DEPLOY_URL="$WORKER_URL" CV_HOOK_SECRET="$HOOKSEC" CV_DASH_TOKEN="$DASH" node <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = path.join(os.homedir(), '.claude');
const hookFile = path.join(dir, 'claudevoice.json');
const appFile = path.join(dir, 'claudevoice-app.json');
const base = process.env.CV_DEPLOY_URL.replace(/\/$/, '');
const secret = process.env.CV_HOOK_SECRET;
const dashboardToken = process.env.CV_DASH_TOKEN;
const relay = base.replace(/^https:/, 'wss:') + '/ws';
const stamp = Date.now();

fs.mkdirSync(dir, { recursive: true });
for (const file of [hookFile, appFile]) {
  if (fs.existsSync(file)) {
    const backup = `${file}.bak.${stamp}`;
    fs.copyFileSync(file, backup);
    console.log(`  已备份 ${file} → ${backup}`);
  }
}

function writePrivate(file, value) {
  const temp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

writePrivate(hookFile, { url: `${base}/hook`, secret });
writePrivate(appFile, { base, token: secret, panelToken: dashboardToken, relay });
console.log(`  ✓ ${hookFile}`);
console.log(`  ✓ ${appFile}`);
NODE

echo ""
echo "================ 部署完成 ================"
echo "Worker：$WORKER_URL"
echo "手机面板：$WORKER_URL/?token=$DASH"
echo "Claude hook 与 Mac App 配置已自动切换，无需手改 JSON。"
echo "=========================================="
