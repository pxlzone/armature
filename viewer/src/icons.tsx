import {
  IconAddressBook, IconBolt, IconBrandLinkedin, IconBrowser, IconClock, IconCloud, IconCreditCard, IconDatabase, IconFileText,
  IconFolders, IconGraph, IconLock, IconMail, IconPackage, IconRobot, IconSearch, IconServer2, IconSettingsAutomation,
  IconServerCog, IconSparkles, IconStack2, IconTerminal2, IconUser, IconWorldWww, type Icon,
} from '@tabler/icons-react';
import type { GNode, NodeKind } from '../../src/types.ts';
import type { Index } from './view.ts';

const BY_KIND: Record<NodeKind, Icon> = {
  actor: IconUser,
  app: IconBrowser,
  service: IconServer2,
  worker: IconSettingsAutomation,
  job: IconClock,
  agent: IconRobot,
  store: IconDatabase,
  queue: IconStack2,
  external: IconCloud,
  library: IconPackage,
  group: IconFolders,
  platform: IconServerCog,
};

const HINTS: Array<[RegExp, Icon]> = [
  [/linkedin/, IconBrandLinkedin],
  [/mail|smtp|imap|resend|inbox/, IconMail],
  [/auth|kyc|identity|login/, IconLock],
  [/llm|gateway|litellm|anthropic|openai|\bai\b/, IconSparkles],
  [/search/, IconSearch],
  [/contact|crm/, IconAddressBook],
  [/stripe|payment|billing/, IconCreditCard],
  [/neo4j|graph/, IconGraph],
  [/temporal|workflow/, IconBolt],
  [/scrap|crawl|browser/, IconWorldWww],
  [/cli|script/, IconTerminal2],
  [/doc|pdf|invoice|report/, IconFileText],
];

export function iconOf(n: GNode): Icon {
  if (n.kind === 'actor' || n.kind === 'store' || n.kind === 'group' || n.kind === 'library') return BY_KIND[n.kind];
  const text = `${n.id} ${n.name} ${n.tech.join(' ')}`.toLowerCase();
  for (const [re, icon] of HINTS) if (re.test(text)) return icon;
  return BY_KIND[n.kind];
}

const KIND_COLOR: Record<NodeKind, string> = {
  actor: 'gray',
  app: 'green',
  service: 'teal',
  worker: 'teal',
  job: 'purple',
  agent: 'pink',
  store: 'blue',
  queue: 'purple',
  external: 'orange',
  library: 'gray',
  group: 'gray',
  platform: 'purple',
};

export function colorOf(n: GNode, ix: Index): string {
  let cur: GNode | undefined = n;
  while (cur) {
    if (cur.color) return `var(--c-${cur.color})`;
    cur = cur.parent ? ix.nodes.get(cur.parent) : undefined;
  }
  return `var(--c-${KIND_COLOR[n.kind]})`;
}
