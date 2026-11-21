const KNOWN_DOMAINS = ['0xio.xyz', 'octra.network', 'octrascan.io', 'octra.org'];

interface DomainSecurityResult {
  isHttpOnly: boolean;
  isLookalikeDomain: boolean;
  lookalikeSimilarTo: string | null;
  isKnownDomain: boolean;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

function extractDomain(origin: string): string {
  try {
    const url = new URL(origin);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return origin.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
  }
}

export function checkDomainSecurity(origin: string): DomainSecurityResult {
  const domain = extractDomain(origin);
  const isHttpOnly = origin.startsWith('http://');
  const isKnownDomain = KNOWN_DOMAINS.some(
    (known) => domain === known || domain.endsWith(`.${known}`)
  );

  let isLookalikeDomain = false;
  let lookalikeSimilarTo: string | null = null;

  if (!isKnownDomain) {
    for (const known of KNOWN_DOMAINS) {
      const distance = levenshteinDistance(domain, known);
      if (distance > 0 && distance <= 2) {
        isLookalikeDomain = true;
        lookalikeSimilarTo = known;
        break;
      }
    }
  }

  return { isHttpOnly, isLookalikeDomain, lookalikeSimilarTo, isKnownDomain };
}

export async function checkFirstConnection(origin: string): Promise<boolean> {
  try {
    const domain = extractDomain(origin);
    const key = `dapp_connection_${domain}`;
    const result = await chrome.storage.local.get(key);
    return !result[key];
  } catch {
    return true;
  }
}
