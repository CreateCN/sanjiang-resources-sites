const BOT_PATTERN = /bot|crawler|spider|crawl|slurp|headless|phantom|curl|wget|python-requests|httpclient|go-http-client|axios|node-fetch|undici/i;

/** Skip counters for bots, scripts and requests without a browser user agent. */
export function isBotRequest(request: Request): boolean {
  const agent = request.headers.get('user-agent') ?? '';
  if (!agent) return true;
  return BOT_PATTERN.test(agent);
}
