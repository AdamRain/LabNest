import { readFileSync } from 'node:fs';
import { httpsOrigin, isLoopback, campusHttpOrigin, isCampusAddress, transportSecurity } from './transport-security.mjs';

function portNumber(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} 须为 1 到 65535 之间的整数。`);
  return port;
}

export function loadTransportConfig(env = process.env) {
  const host = env.LAB_HOST || '127.0.0.1';
  const port = portNumber(env.LAB_PORT || '4173', 'LAB_PORT');
  const keyFile = env.LAB_TLS_KEY_FILE || '';
  const certFile = env.LAB_TLS_CERT_FILE || '';
  if (Boolean(keyFile) !== Boolean(certFile)) throw new Error('HTTPS 必须同时配置证书和私钥。');
  const mode = env.LAB_TRANSPORT_MODE || (keyFile ? 'tls' : 'development');
  if (!['development', 'tls', 'proxy', 'legacy-http'].includes(mode)) throw new Error('LAB_TRANSPORT_MODE 须为 development、tls、proxy 或 legacy-http。');
  const local = host === 'localhost' || isLoopback(host);
  if (mode === 'development' && (!local || env.NODE_ENV === 'production')) {
    throw new Error('明文 HTTP 仅用于本机开发；请配置 HTTPS 或可信的同机反向代理。');
  }
  if (mode === 'proxy' && (!local || keyFile)) throw new Error('代理后端须监听本机回环地址，且不混用应用 TLS 配置。');
  if (mode === 'tls' && !keyFile) throw new Error('HTTPS 模式缺少证书或私钥。');
  if (mode !== 'tls' && keyFile) throw new Error('证书只能用于 HTTPS 模式。');
  if (mode === 'legacy-http' && (env.LAB_ALLOW_INSECURE_HTTP !== '1' || !isCampusAddress(host) || !env.LAB_CANONICAL_URL)) {
    throw new Error('临时 HTTP 兼容模式须明确设置 LAB_ALLOW_INSECURE_HTTP=1，绑定具体私网 IPv4 并填写网站地址。');
  }
  const hostname = host.includes(':') ? `[${host}]` : host;
  const fallback = `${mode === 'tls' ? 'https' : 'http'}://${hostname}:${port}`;
  const canonicalUrl = env.LAB_CANONICAL_URL
    ? (mode === 'legacy-http' ? campusHttpOrigin(env.LAB_CANONICAL_URL) : httpsOrigin(env.LAB_CANONICAL_URL)) : fallback;
  if ((mode === 'proxy' || (mode === 'tls' && !local)) && !env.LAB_CANONICAL_URL) {
    throw new Error('请配置实际的 LAB_CANONICAL_URL HTTPS 网站根地址。');
  }
  const trustedProxies = (env.LAB_TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean);
  if (mode === 'proxy' && !trustedProxies.length) throw new Error('请明确配置同机反向代理的 IP。');
  const redirectPort = env.LAB_HTTP_REDIRECT_PORT ? portNumber(env.LAB_HTTP_REDIRECT_PORT, 'LAB_HTTP_REDIRECT_PORT') : null;
  if (redirectPort && (mode !== 'tls' || redirectPort === port)) throw new Error('HTTP 跳转端口只用于 HTTPS 模式，且须与 HTTPS 端口不同。');
  const transport = { mode, trustedProxies, publicOrigin: mode === 'development' ? '' : canonicalUrl,
    ...(mode === 'legacy-http' ? { allowInsecureHttp: true, bindHost: host, bindPort: port } : {}) };
  transportSecurity(transport);
  return { host, port, canonicalUrl, redirectPort,
    tls: mode === 'tls' ? { key: readFileSync(keyFile), cert: readFileSync(certFile) } : null,
    transport };
}
