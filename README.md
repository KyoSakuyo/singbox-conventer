# Cloudflare Worker sing-box 配置生成器

这是一个单文件 Cloudflare Worker。只要在 Cloudflare 网页面板里完成配置，就不需要 `wrangler.toml`。

## 必需的面板配置

KV namespace binding：

```text
CONFIG_KV
```

环境变量：

```text
DEFAULT_TEMPLATE_URL = https://...
DEFAULT_KURASSHU_URL = https://...
ACCESS_TOKEN = your-private-token
```

可选环境变量：

```text
USER_AGENT = clash.meta
```

如果 URL 里带 token，建议在 Cloudflare 面板里设置为 secret 或加密变量，不要明文提交到仓库。

## 访问地址

```text
/singbox2.json?token=your-private-token
/config.json?token=your-private-token
/health?token=your-private-token
```

`/singbox2.json` 和 `/config.json` 返回生成后的 sing-box JSON，可以直接给 sing-box App 使用。

`/health` 用来查看刷新状态、抓取到的 provider 数量、节点数量和错误信息。

根路径 `/` 返回 404。没有携带正确 `token` 参数的请求返回 401。如果没有配置 `ACCESS_TOKEN`，受保护接口返回 503。

## 缓存和刷新

第一次绑定时，KV 可以是空的。

当 `CONFIG_KV` 为空时，第一次访问 `/singbox2.json?token=...` 会立即生成配置，并写入 KV。之后的请求会直接返回 KV 里的缓存配置。

如果缓存超过 10 分钟，请求会先返回旧配置，同时在后台刷新。这样即使上游 provider 暂时失败，也能继续返回上一次成功生成的配置。

## Cron

在 Cloudflare 网页面板里添加 Cron Trigger：

```text
*/10 * * * *
```

Cron 会每 10 分钟自动刷新：

- 远程 `singbox2.json` 模板
- 远程 `kurasshu.yaml`
- `proxy-providers` 里的所有 provider
- 转换后的 sing-box JSON
- `/health` 状态信息

不设置 Cron 也能用，但只有客户端访问时才会触发刷新。建议设置 Cron。

## 注意事项

- KV namespace 首次绑定时可以为空。
- KV binding name 必须严格写成 `CONFIG_KV`。
- 访问 token 使用环境变量 `ACCESS_TOKEN` 设置。
- 当前节点转换覆盖 `anytls`、`hysteria2`、`ss`、`vless`、`vmess`。
- 模板中的代理节点按 JSON 结构和 outbound 类型识别，不依赖行号。
