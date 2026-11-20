// Shared shapes of the credential proxy (docs/decisions/credential-proxy.md).
export interface ProxyEndpoint { url: string; token: string }
export type UpstreamKind = 'xApiKey' | 'bearer'
export interface Upstream { baseUrl: string; kind: UpstreamKind; secret: string; headers: Record<string, string> }
export type ProxyErrorCode = 'bad_proxy_token' | 'no_upstream' | 'upstream_unreachable' | 'upstream_timeout' | 'proxy_busy' | 'body_too_large' | 'bad_request'
