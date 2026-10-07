#!/usr/bin/env node
/**
 * 生成 Web Push 用的 VAPID 密钥对。
 *   node cloudflare/scripts/gen-vapid.mjs
 * 把输出的 VAPID_PUBLIC / VAPID_PRIVATE 用 `wrangler secret put` 设进 Worker。
 */
import { webcrypto as c } from 'node:crypto';

const kp = await c.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubRaw = new Uint8Array(await c.subtle.exportKey('raw', kp.publicKey)); // 65 字节未压缩点
const privJwk = await c.subtle.exportKey('jwk', kp.privateKey);
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log('\n=== VAPID 密钥（请妥善保存）===\n');
console.log('VAPID_PUBLIC（公钥，浏览器订阅 + 鉴权头都用它）:');
console.log(b64url(pubRaw));
console.log('\nVAPID_PRIVATE（私钥 JWK，整行作为一个 secret）:');
console.log(JSON.stringify(privJwk));
console.log('\n设置方式：');
console.log('  echo -n "<上面的公钥>"  | npx wrangler secret put VAPID_PUBLIC');
console.log('  echo -n \'<上面的JWK>\' | npx wrangler secret put VAPID_PRIVATE');
console.log('  echo -n "mailto:你@邮箱"  | npx wrangler secret put VAPID_SUBJECT');
