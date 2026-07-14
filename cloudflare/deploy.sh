#!/bin/bash
# ClaudeVoice 一键部署到 Cloudflare
# 用法：
#   1) 先登录：  npx wrangler login        （浏览器里授权一次）
#   2) 再部署：  cd cloudflare && bash deploy.sh
# 可选：部署前 export 这些再跑（会一并设为 secret）：
#   export LARK_WEBHOOK_URL="https://open.feishu.cn/open-apis/bot/v2/hook/xxxx"
#   export LARK_WEBHOOK_SECRET="飞书签名密钥（没开签名就不用）"
#   export TELEGRAM_BOT_TOKEN="..."   export TELEGRAM_CHAT_ID="..."
set -e
cd "$(dirname "$0")"

echo "== 检查登录 =="
npx wrangler whoami >/dev/null 2>&1 || { echo "✗ 还没登录，请先运行： npx wrangler login"; exit 1; }

# 共享密钥从项目 .env 复用
MIMO=$(grep -E '^MIMO_API_KEY=' ../.env | head -1 | cut -d= -f2-)
HOOKSEC=$(grep -E '^HOOK_SECRET=' ../.env | head -1 | cut -d= -f2-)
[ -n "$HOOKSEC" ] || HOOKSEC=$(openssl rand -hex 16)
DASH=${DASH_TOKEN:-$(openssl rand -hex 16)}
SUBJECT=${VAPID_SUBJECT:-mailto:sunlinhua@gmail.com}

echo "== 生成 VAPID 密钥（Web Push）=="
VAPID=$(node -e 'const {webcrypto:c}=require("crypto");(async()=>{const kp=await c.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);const b=x=>Buffer.from(x).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");const pub=b(await c.subtle.exportKey("raw",kp.publicKey));const priv=JSON.stringify(await c.subtle.exportKey("jwk",kp.privateKey));process.stdout.write(pub+"\n"+priv);})();')
VPUB=$(printf '%s\n' "$VAPID" | sed -n '1p')
VPRIV=$(printf '%s\n' "$VAPID" | sed -n '2p')

echo "== 首次 deploy（创建 Worker）=="
npx wrangler deploy

put(){ printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null 2>&1 && echo "  ✓ $1" || echo "  ✗ $1"; }
echo "== 设置 secrets =="
put MIMO_API_KEY "$MIMO"
put HOOK_SECRET "$HOOKSEC"
put DASH_TOKEN "$DASH"
put VAPID_PUBLIC "$VPUB"
put VAPID_PRIVATE "$VPRIV"
put VAPID_SUBJECT "$SUBJECT"
# 飞书机器人私信凭证（从项目 .env 复用）
LARK_APP_ID=$(grep -E '^LARK_APP_ID=' ../.env | head -1 | cut -d= -f2-)
LARK_APP_SECRET=$(grep -E '^LARK_APP_SECRET=' ../.env | head -1 | cut -d= -f2-)
LARK_OPEN_ID=$(grep -E '^LARK_OPEN_ID=' ../.env | head -1 | cut -d= -f2-)
[ -n "$LARK_APP_ID" ] && put LARK_APP_ID "$LARK_APP_ID"
[ -n "$LARK_APP_SECRET" ] && put LARK_APP_SECRET "$LARK_APP_SECRET"
[ -n "$LARK_OPEN_ID" ] && put LARK_OPEN_ID "$LARK_OPEN_ID"
[ -n "$LARK_WEBHOOK_URL" ] && put LARK_WEBHOOK_URL "$LARK_WEBHOOK_URL"
[ -n "$LARK_WEBHOOK_SECRET" ] && put LARK_WEBHOOK_SECRET "$LARK_WEBHOOK_SECRET"
[ -n "$TELEGRAM_BOT_TOKEN" ] && put TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
[ -n "$TELEGRAM_CHAT_ID" ] && put TELEGRAM_CHAT_ID "$TELEGRAM_CHAT_ID"

echo "== 重新 deploy 使 secret 生效 =="
npx wrangler deploy

echo ""
echo "================ 完成 ================"
echo "DASH_TOKEN = $DASH"
echo "HOOK_SECRET = $HOOKSEC"
echo "面板（手机打开，带 token）: https://claudevoice.<你的子域>.workers.dev/?token=$DASH"
echo "（上面的 workers.dev 子域见 deploy 输出里的 Published 行）"
echo ""
echo "最后一步：把 ~/.claude/claudevoice.json 改成指向 Worker："
echo "   { \"url\": \"https://claudevoice.<你的子域>.workers.dev/hook\", \"secret\": \"$HOOKSEC\" }"
echo "===================================="
