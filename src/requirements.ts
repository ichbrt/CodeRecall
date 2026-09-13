import { z } from 'zod';
import type { Requirements } from './domain.js';
import { secretDetected } from './safety.js';

export const featurePatterns: Record<string, RegExp> = {
  auth: /\b(?:auth|authentication|signin|login|session)\b/i,
  billing: /\b(?:billing|subscriptions?|payments?|stripe)\b/i,
  admin: /\b(?:admin|administration|dashboard)\b/i,
  booking: /\b(?:booking|appointments?|reservations?)\b/i,
  availability: /\b(?:availability|schedules?|timeslots?)\b/i,
  notifications: /\b(?:notifications?|notify)\b/i,
  email: /\b(?:emails?|mailer|smtp)\b/i,
  rbac: /\b(?:rbac|authorization|permissions?)\b/i,
  localization: /\b(?:localization|i18n|multilingual|translations?)\b/i,
};
const normalizeText = (text: string) => text.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_/.-]/g, ' ');
export function detectFeatures(text: string): string[] {
  return Object.entries(featurePatterns).filter(([, pattern]) => pattern.test(normalizeText(text))).map(([name]) => name);
}

const versions = z.record(z.string().min(1).max(80));
export const requirementsSchema = z.object({
  description: z.string().min(1).max(16_000),
  features: z.array(z.string().min(1).max(80)).max(100),
  platform: z.enum(['web', 'server', 'mobile', 'library', 'unknown']).nullable().default(null),
  language: z.string().nullable().default(null),
  frameworks: versions.default({}),
  runtime: z.string().nullable().default(null),
  database: z.string().nullable().default(null),
  orm: z.string().nullable().default(null),
  dependencies: versions.default({}),
  removeFeatures: z.array(z.string()).default([]),
  changes: z.array(z.object({ feature: z.string(), instruction: z.string().max(2000) }).strict()).default([]),
}).strict();

export function parseRequirements(input: string | unknown): Requirements {
  if (typeof input !== 'string') {
    const parsed = requirementsSchema.parse(input);
    if (secretDetected(JSON.stringify(parsed))) throw new Error('Requirements contain a potential secret; remove it before indexing.');
    if (parsed.features.some(feature => parsed.removeFeatures.includes(feature))) throw new Error('A feature cannot be both required and removed.');
    return { ...parsed, features: [...new Set(parsed.features)].sort() };
  }
  if (input.trim().startsWith('{')) return parseRequirements(JSON.parse(input));
  if (/\b(?:no|not|without|exclude|excluding|remove|removing)\b/i.test(input)) throw new Error('Prose with negation or removal is ambiguous. Use structured JSON features and removeFeatures.');
  const frameworks: Record<string, string> = {};
  const versionRequirement = (pattern: RegExp): string | undefined => {
    const match = pattern.exec(input);
    if (!match) return undefined;
    return match[1] ? match[1].split('.').length < 3 ? `${match[1]}.x` : match[1] : '*';
  };
  const next = versionRequirement(/\bnext(?:\.js|js)?\b(?:\s+(?:v(?:ersion)?\s*)?(\d+(?:\.\d+){0,2}))?/i);
  const express = versionRequirement(/\bexpress\b(?:\s+(?:v(?:ersion)?\s*)?(\d+(?:\.\d+){0,2}))?/i);
  const flutter = versionRequirement(/\bflutter\b(?:\s+(?:v(?:ersion)?\s*)?(\d+(?:\.\d+){0,2}))?/i);
  const node = versionRequirement(/\bnode(?:\.js)?\b(?:\s+(?:v(?:ersion)?\s*)?(\d+(?:\.\d+){0,2}))?/i);
  if (next) frameworks.next = next;
  if (express) frameworks.express = express;
  if (flutter) frameworks.flutter = flutter;
  const platform = frameworks.flutter ? 'mobile' : frameworks.next ? 'web' : frameworks.express ? 'server' : null;
  return parseRequirements({
    description: input,
    features: detectFeatures(input),
    frameworks,
    platform,
    language: /\btypescript\b/i.test(input) ? 'TypeScript' : null,
    runtime: node && node !== '*' ? `node ${node}` : node || frameworks.next || frameworks.express ? 'node' : null,
    database: /\b(postgres(?:ql)?)\b/i.test(input) ? 'postgresql' : /\bsqlite\b/i.test(input) ? 'sqlite' : null,
    orm: /\bprisma\b/i.test(input) ? 'prisma' : null,
  });
}
