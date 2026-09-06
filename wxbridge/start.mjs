/**
 * start.mjs — 服务入口。
 * 单独拆出来是因为 pm2 fork 模式下 process.argv[1] 指向 pm2 的容器脚本，
 * index.mjs 里那种 "是否被直接执行" 的判断不成立，main() 不会被调用。
 */
import { main } from './index.mjs';

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
