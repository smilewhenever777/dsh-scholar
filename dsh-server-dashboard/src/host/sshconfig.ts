/**
 * Minimal OpenSSH config parser — enough for the "import from ~/.ssh/config"
 * feature: Host blocks with HostName/Port/User/IdentityFile.
 * Ignores glob patterns, includes, Match blocks.
 */
export interface ImportedSshHost {
  alias: string;
  host: string;
  port: number;
  username: string;
  identityFile?: string;
}

export function parseSshConfig(text: string): ImportedSshHost[] {
  const out: ImportedSshHost[] = [];
  const lines = text.split(/\r?\n/);
  let current: Partial<ImportedSshHost> | null = null;
  let hostEntries: string[] = [];

  const flush = () => {
    if (current && hostEntries.length > 0) {
      for (const alias of hostEntries) {
        if (alias.includes('*') || alias.includes('?')) continue; // skip patterns
        out.push({
          alias,
          // OpenSSH semantics: a Host block without HostName connects to the alias itself
          host: current.host ?? alias,
          port: current.port ?? 22,
          username: current.username ?? 'root',
          identityFile: current.identityFile,
        });
      }
    }
    current = null;
    hostEntries = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.search(/\s|=/);
    if (idx === -1) continue;
    let key = line.slice(0, idx).toLowerCase();
    let value = line.slice(idx + 1).trim().replace(/^=/, '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    switch (key) {
      case 'host':
        flush();
        hostEntries = value.split(/\s+/).filter(Boolean);
        current = {};
        break;
      case 'match':
        // Match 块依赖连接时上下文(用户/主机/命令),静态解析无法判定成立与否 —
        // flush 置空 current 进入丢弃态,块内参数无处并入,直到下一个 Host/Match
        flush();
        break;
      case 'hostname':
        if (current) current.host = value;
        break;
      case 'port':
        if (current) current.port = Number(value) || 22;
        break;
      case 'user':
        if (current) current.username = value;
        break;
      case 'identityfile':
        if (current) current.identityFile = value.replace(/^~/, process.env.USERPROFILE ?? process.env.HOME ?? '~');
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}
