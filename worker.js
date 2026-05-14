const DEFAULT_USER_AGENT = "clash.meta";
const CONFIG_KEY = "singbox2.json";
const HEALTH_KEY = "health.json";
const CACHE_SECONDS = 600;

const CONTROL_OUTBOUND_TYPES = new Set(["block", "direct", "dns", "selector", "urltest"]);
const CONCRETE_OUTBOUND_TYPES = new Set([
  "anytls",
  "hysteria",
  "hysteria2",
  "http",
  "naive",
  "shadowsocks",
  "shadowtls",
  "socks",
  "ssh",
  "trojan",
  "tuic",
  "vless",
  "vmess",
  "wireguard",
]);

const REGION_PATTERNS = {
  HK: /(香港|港|🇭🇰|\bHK\b|Hong\s*Kong)/i,
  JP: /(日本|日|🇯🇵|\bJP\b|Japan)/i,
  SG: /(新加坡|狮城|坡|🇸🇬|\bSG\b|Singapore)/i,
  US: /(美国|美|🇺🇸|\bUS\b|United\s*States)/i,
  TW: /(台湾|台|🇹🇼|\bTW\b|Taiwan)/i,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Not found\n", { status: 404 });
    }

    const auth = authorizeRequest(url, env);
    if (!auth.ok) {
      return new Response("Unauthorized\n", {
        status: auth.status,
        headers: { "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/health") {
      return jsonResponse(await readHealth(env), 200);
    }

    if (url.pathname !== "/singbox2.json" && url.pathname !== "/config.json") {
      return new Response("Not found\n", { status: 404 });
    }

    let config = await env.CONFIG_KV.get(CONFIG_KEY);
    const health = await readHealth(env);
    const stale = !health.last_success || Date.now() - health.last_success > CACHE_SECONDS * 1000;

    if (!config) {
      const built = await refreshConfig(env);
      config = built.body;
    } else if (stale && ctx) {
      ctx.waitUntil(refreshConfig(env));
    }

    return new Response(config, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshConfig(env));
  },
};

async function refreshConfig(env) {
  try {
    requireEnv(env, "CONFIG_KV");
    const templateUrl = requireEnv(env, "DEFAULT_TEMPLATE_URL");
    const kurasshuUrl = requireEnv(env, "DEFAULT_KURASSHU_URL");
    const userAgent = env.USER_AGENT || DEFAULT_USER_AGENT;

    const template = await fetchJson(templateUrl, userAgent);
    const kurasshuText = await fetchText(kurasshuUrl, userAgent);
    const urls = extractProviderUrls(kurasshuText);

    const allProxies = [];
    let providerCount = 0;
    for (const providerUrl of urls) {
      const providerText = await fetchText(providerUrl, userAgent);
      const proxies = parseClashProxies(providerText);
      if (!proxies.length) {
        console.warn(`provider has no proxies: ${providerUrl}`);
        continue;
      }
      providerCount += 1;
      allProxies.push(...proxies);
    }

    const { outbounds, skipped } = convertProxies(allProxies);
    const result = replaceTemplateProxies(template, outbounds);
    const body = JSON.stringify(result, null, 2) + "\n";
    const health = {
      ok: true,
      last_success: Date.now(),
      last_error: null,
      stats: {
        providers: providerCount,
        source_proxies: allProxies.length,
        converted_proxies: outbounds.length,
        skipped,
      },
    };

    await env.CONFIG_KV.put(CONFIG_KEY, body);
    await env.CONFIG_KV.put(HEALTH_KEY, JSON.stringify(health, null, 2));
    return { body, health };
  } catch (error) {
    const oldHealth = await readHealth(env).catch(() => ({}));
    const health = {
      ...oldHealth,
      ok: false,
      last_error: error && error.stack ? error.stack : String(error),
    };
    if (env.CONFIG_KV) {
      await env.CONFIG_KV.put(HEALTH_KEY, JSON.stringify(health, null, 2));
    }
    throw error;
  }
}

async function fetchText(url, userAgent) {
  const response = await fetch(url, { headers: { "user-agent": userAgent } });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  }
  return response.text();
}

async function fetchJson(url, userAgent) {
  const text = await fetchText(url, userAgent);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`failed to parse JSON from ${url}: ${error.message}`);
  }
}

function extractProviderUrls(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const urls = [];
  let inProviders = false;

  for (const rawLine of lines) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue;

    if (/^proxy-providers:\s*$/.test(line)) {
      inProviders = true;
      continue;
    }
    if (inProviders && /^\S/.test(line)) break;

    if (inProviders) {
      const match = line.match(/^\s{4}url:\s*(.+?)\s*$/);
      if (match) urls.push(parseScalar(match[1]));
    }
  }

  if (!urls.length) {
    throw new Error("kurasshu.yaml does not contain proxy-providers URLs");
  }
  return urls;
}

function parseClashProxies(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const proxies = [];
  let inProxies = false;
  let current = null;
  let stack = [];

  for (const rawLine of lines) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue;

    if (!inProxies) {
      if (/^proxies:\s*$/.test(line)) inProxies = true;
      continue;
    }

    if (/^\S/.test(line) && !/^proxies:\s*$/.test(line)) break;

    const indent = countIndent(line);
    const trimmed = line.trim();

    if (indent >= 2 && trimmed.startsWith("- ")) {
      current = {};
      proxies.push(current);
      stack = [{ indent, value: current }];
      parseListItemInto(current, trimmed.slice(2).trim());
      continue;
    }

    if (!current) continue;
    parseNestedLine(stack, indent, trimmed);
  }

  return proxies;
}

function parseNestedLine(stack, indent, trimmed) {
  while (stack.length && stack[stack.length - 1].indent >= indent) {
    stack.pop();
  }
  const parent = stack[stack.length - 1]?.value;
  if (!parent || typeof parent !== "object") return;

  if (trimmed.startsWith("- ")) {
    if (Array.isArray(parent)) {
      parent.push(parseScalar(trimmed.slice(2).trim()));
    }
    return;
  }

  const pair = splitKeyValue(trimmed);
  if (!pair) return;

  const [key, value] = pair;
  if (value === "") {
    const container = key === "alpn" ? [] : {};
    parent[key] = container;
    stack.push({ indent, value: container });
  } else {
    parent[key] = parseScalar(value);
  }
}

function parseListItemInto(target, text) {
  if (text.startsWith("{") && text.endsWith("}")) {
    Object.assign(target, parseFlowMap(text));
    return;
  }
  parseMappingInto(target, text);
}

function parseMappingInto(target, text) {
  const pair = splitKeyValue(text);
  if (!pair) return;
  const [key, value] = pair;
  target[key] = value === "" ? {} : parseScalar(value);
}

function splitKeyValue(text) {
  const index = text.indexOf(":");
  if (index < 0) return null;
  return [text.slice(0, index).trim(), text.slice(index + 1).trim()];
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if ((char === "\"" || char === "'") && line[i - 1] !== "\\") {
      quote = quote === char ? null : quote || char;
    }
    if (char === "#" && !quote && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function parseScalar(value) {
  const text = String(value).trim();
  if (!text) return "";
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (text.startsWith("[") && text.endsWith("]")) {
    const body = text.slice(1, -1).trim();
    if (!body) return [];
    return splitTopLevel(body, ",").map(parseScalar);
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    return parseFlowMap(text);
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function parseFlowMap(text) {
  const body = text.slice(1, -1).trim();
  if (!body) return {};
  const object = {};
  for (const item of splitTopLevel(body, ",")) {
    const pair = splitTopLevel(item, ":");
    if (pair.length < 2) continue;
    const key = pair[0].trim();
    const value = pair.slice(1).join(":").trim();
    object[unquote(key)] = parseScalar(value);
  }
  return object;
}

function splitTopLevel(text, separator) {
  const parts = [];
  let quote = null;
  let squareDepth = 0;
  let braceDepth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if ((char === "\"" || char === "'") && text[i - 1] !== "\\") {
      quote = quote === char ? null : quote || char;
    }
    if (!quote) {
      if (char === "[") squareDepth += 1;
      if (char === "]") squareDepth -= 1;
      if (char === "{") braceDepth += 1;
      if (char === "}") braceDepth -= 1;
    }
    if (char === separator && !quote && squareDepth === 0 && braceDepth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function unquote(text) {
  const trimmed = String(text).trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function countIndent(line) {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function convertProxies(proxies) {
  const used = new Set();
  const outbounds = [];
  const skipped = {};

  for (const proxy of proxies) {
    const type = String(proxy?.type || "unknown").toLowerCase();
    const tag = uniqueTag(proxy?.name, used);
    try {
      outbounds.push(convertProxy(proxy, tag));
    } catch (error) {
      skipped[type] = (skipped[type] || 0) + 1;
      console.warn(`skip proxy ${proxy?.name || tag} (${type}): ${error.message}`);
    }
  }

  if (!outbounds.length) throw new Error("all proxies were skipped");
  return { outbounds, skipped };
}

function convertProxy(proxy, tag) {
  const type = String(proxy.type || "").toLowerCase();

  if (type === "hysteria2") {
    const outbound = baseOutbound(proxy, "hysteria2", tag);
    outbound.password = String(proxy.password || "");
    const tls = tlsConfig(proxy, true);
    if (tls) outbound.tls = tls;
    return outbound;
  }

  if (type === "vless") {
    const outbound = baseOutbound(proxy, "vless", tag);
    outbound.uuid = String(proxy.uuid || "");
    if (proxy.flow) outbound.flow = String(proxy.flow);
    if (proxy.network === "tcp" || proxy.network === "udp") outbound.network = proxy.network;
    const tls = tlsConfig(proxy, false);
    if (tls) outbound.tls = tls;
    const transport = wsTransport(proxy);
    if (transport) outbound.transport = transport;
    return outbound;
  }

  if (type === "anytls") {
    const outbound = baseOutbound(proxy, "anytls", tag);
    outbound.password = String(proxy.password || "");
    const tls = tlsConfig(proxy, true);
    if (!tls) throw new Error("AnyTLS requires TLS");
    outbound.tls = tls;
    return outbound;
  }

  if (type === "ss") {
    const outbound = baseOutbound(proxy, "shadowsocks", tag);
    outbound.method = String(proxy.cipher || "");
    outbound.password = String(proxy.password || "");
    return outbound;
  }

  if (type === "vmess") {
    const outbound = baseOutbound(proxy, "vmess", tag);
    outbound.uuid = String(proxy.uuid || "");
    outbound.security = String(proxy.cipher || "auto");
    outbound.alter_id = Number(proxy.alterId || 0);
    if (proxy.udp === false) outbound.network = "tcp";
    const tls = tlsConfig(proxy, false);
    if (tls) outbound.tls = tls;
    const transport = wsTransport(proxy);
    if (transport) outbound.transport = transport;
    return outbound;
  }

  throw new Error(`unsupported proxy type ${type}`);
}

function baseOutbound(proxy, type, tag) {
  if (!proxy.server || proxy.port == null) throw new Error("missing server or port");
  return {
    tag,
    type,
    server: String(proxy.server),
    server_port: Number(proxy.port),
  };
}

function tlsConfig(proxy, defaultEnabled) {
  const enabled = Boolean(proxy.tls ?? defaultEnabled);
  if (!enabled) return null;

  const tls = { enabled: true };
  const serverName = proxy.servername || proxy.sni;
  if (serverName) tls.server_name = String(serverName);
  if ("skip-cert-verify" in proxy) tls.insecure = Boolean(proxy["skip-cert-verify"]);
  if (Array.isArray(proxy.alpn) && proxy.alpn.length) tls.alpn = proxy.alpn.map(String);
  if (proxy["client-fingerprint"]) {
    tls.utls = { enabled: true, fingerprint: String(proxy["client-fingerprint"]) };
  }
  if (proxy["reality-opts"] && typeof proxy["reality-opts"] === "object") {
    tls.reality = { enabled: true };
    if (proxy["reality-opts"]["public-key"]) {
      tls.reality.public_key = String(proxy["reality-opts"]["public-key"]);
    }
    if (proxy["reality-opts"]["short-id"] != null) {
      tls.reality.short_id = String(proxy["reality-opts"]["short-id"]);
    }
  }
  return tls;
}

function wsTransport(proxy) {
  if (String(proxy.network || "").toLowerCase() !== "ws") return null;
  const opts = proxy["ws-opts"] && typeof proxy["ws-opts"] === "object" ? proxy["ws-opts"] : {};
  const transport = { type: "ws" };
  const path = opts.path || proxy["ws-path"];
  if (path) transport.path = String(path);
  const headers = opts.headers || proxy["ws-headers"];
  if (headers && typeof headers === "object") {
    transport.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [String(key), String(value)]));
  }
  return transport;
}

function uniqueTag(name, used) {
  const base = String(name || "proxy").trim() || "proxy";
  let tag = base;
  let suffix = 2;
  while (used.has(tag)) {
    tag = `${base} (${suffix})`;
    suffix += 1;
  }
  used.add(tag);
  return tag;
}

function replaceTemplateProxies(template, newOutbounds) {
  if (!Array.isArray(template.outbounds)) throw new Error("template does not contain outbounds array");

  const oldTags = new Set();
  let insertAt = null;
  const kept = [];

  for (const outbound of template.outbounds) {
    if (isConcreteOutbound(outbound)) {
      if (insertAt === null) insertAt = kept.length;
      if (typeof outbound.tag === "string") oldTags.add(outbound.tag);
      continue;
    }
    kept.push(outbound);
  }

  if (insertAt === null) insertAt = kept[0]?.type === "direct" ? 1 : 0;
  template.outbounds = [...kept.slice(0, insertAt), ...newOutbounds, ...kept.slice(insertAt)];
  replaceOutboundReferences(template.outbounds, oldTags, newOutbounds.map((item) => item.tag));
  return template;
}

function isConcreteOutbound(outbound) {
  if (!outbound || typeof outbound !== "object") return false;
  const type = String(outbound.type || "").toLowerCase();
  return !CONTROL_OUTBOUND_TYPES.has(type) && CONCRETE_OUTBOUND_TYPES.has(type);
}

function replaceOutboundReferences(outbounds, oldTags, newTags) {
  if (!oldTags.size) return;
  const regions = classifyRegionTags(newTags);

  for (const outbound of outbounds) {
    if (!Array.isArray(outbound?.outbounds)) continue;
    if (!outbound.outbounds.some((tag) => oldTags.has(tag))) continue;

    const replacement = replacementTagsForGroup(String(outbound.tag || ""), newTags, regions);
    const merged = [];
    for (const tag of outbound.outbounds) {
      if (oldTags.has(tag)) {
        for (const newTag of replacement) {
          if (!merged.includes(newTag)) merged.push(newTag);
        }
      } else if (!merged.includes(tag)) {
        merged.push(tag);
      }
    }
    outbound.outbounds = merged;
  }
}

function classifyRegionTags(tags) {
  const regions = { HK: [], JP: [], SG: [], US: [], TW: [] };
  for (const tag of tags) {
    for (const [region, pattern] of Object.entries(REGION_PATTERNS)) {
      if (pattern.test(tag)) regions[region].push(tag);
    }
  }
  return regions;
}

function replacementTagsForGroup(groupTag, allTags, regions) {
  const upper = groupTag.toUpperCase();
  for (const [region, tags] of Object.entries(regions)) {
    if (upper.includes(region) && tags.length) return tags;
  }
  return allTags;
}

async function readHealth(env) {
  const text = await env.CONFIG_KV.get(HEALTH_KEY);
  if (!text) return { ok: false, last_success: null, last_error: "not refreshed yet", stats: {} };
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, last_success: null, last_error: "invalid health data", stats: {} };
  }
}

function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`missing required binding or environment variable: ${name}`);
  return value;
}

function authorizeRequest(url, env) {
  const expected = env.ACCESS_TOKEN;
  if (!expected) return { ok: false, status: 503 };
  const actual = url.searchParams.get("token");
  if (!actual || actual !== expected) return { ok: false, status: 401 };
  return { ok: true, status: 200 };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
