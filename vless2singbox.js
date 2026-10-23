// 把 NODE_LINK（vless:// 链接）转换成 sing-box 配置，本机监听 SOCKS5
// 用法: NODE_LINK='vless://...' node vless2singbox.js config.json
const fs = require('fs');

const link = (process.env.NODE_LINK || '').trim();
const outFile = process.argv[2] || 'config.json';
const listenPort = Number(process.env.PROXY_PORT || 1080);

if (!link.startsWith('vless://')) {
    console.error('NODE_LINK 不是 vless:// 开头的链接');
    process.exit(1);
}

const u = new URL(link);
const q = u.searchParams;
const server = u.hostname.replace(/^\[|\]$/g, '');
const port = Number(u.port || 443);
const uuid = decodeURIComponent(u.username);

let type = (q.get('type') || 'tcp').toLowerCase();
if (type === 'h2') type = 'http';
const security = (q.get('security') || 'none').toLowerCase();
const hostHeader = q.get('host') || '';
const path = q.get('path') ? decodeURIComponent(q.get('path')) : '/';

const outbound = {
    type: 'vless',
    tag: 'proxy',
    server,
    server_port: port,
    uuid,
    packet_encoding: 'xudp',
};

// flow（xtls-rprx-vision 等，仅 tcp 有效）
if (q.get('flow') && type === 'tcp') outbound.flow = q.get('flow');

// TLS / REALITY
if (security === 'tls' || security === 'reality') {
    const tls = {
        enabled: true,
        server_name: q.get('sni') || q.get('peer') || hostHeader || server,
    };
    if (q.get('allowInsecure') === '1' || q.get('insecure') === '1') tls.insecure = true;
    if (q.get('alpn')) {
        let alpn = decodeURIComponent(q.get('alpn')).split(',').filter(Boolean);
        if (type === 'ws') alpn = alpn.filter((a) => a !== 'h2'); // ws 不能跑在 h2 上
        if (alpn.length) tls.alpn = alpn;
    }
    if (q.get('fp') || security === 'reality') {
        tls.utls = { enabled: true, fingerprint: q.get('fp') || 'chrome' };
    }
    if (security === 'reality') {
        tls.reality = {
            enabled: true,
            public_key: q.get('pbk') || '',
            short_id: q.get('sid') || '',
        };
    }
    outbound.tls = tls;
}

// 传输层：ws / grpc / http(h2) / httpupgrade / tcp
switch (type) {
    case 'ws':
        outbound.transport = { type: 'ws', path };
        if (hostHeader) outbound.transport.headers = { Host: hostHeader };
        break;
    case 'grpc':
        outbound.transport = {
            type: 'grpc',
            service_name: q.get('serviceName') || q.get('service_name') || '',
        };
        break;
    case 'http':
        outbound.transport = { type: 'http', path };
        if (hostHeader) outbound.transport.host = hostHeader.split(',');
        break;
    case 'httpupgrade':
        outbound.transport = { type: 'httpupgrade', path };
        if (hostHeader) outbound.transport.host = hostHeader;
        break;
    case 'tcp':
        break; // 纯 tcp 无需 transport
    default:
        console.error(`暂不支持的传输类型: ${type}`);
        process.exit(1);
}

const config = {
    log: { level: 'warn', timestamp: true },
    inbounds: [
        { type: 'socks', tag: 'socks-in', listen: '127.0.0.1', listen_port: listenPort },
    ],
    outbounds: [outbound, { type: 'direct', tag: 'direct' }],
    route: { final: 'proxy' },
};

fs.writeFileSync(outFile, JSON.stringify(config, null, 2));
// 不打印服务器地址、UUID，避免公开仓库日志泄露
console.log(`配置已生成: transport=${type}, security=${security}, 本地 SOCKS5 端口=${listenPort}`);
