import { customAlphabet } from 'nanoid'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const nano = customAlphabet(ALPHABET, 20)

export const ID_PREFIXES = {
  tenant: 'ten',
  user: 'usr',
  session: 'ses',
  apiKey: 'key',
  extension: 'ext',
  storeCredential: 'cred',
  publishTarget: 'tgt',
  artifact: 'art',
  deploymentVersion: 'dep',
  publishEvent: 'pev',
  product: 'prod',
  license: 'lic',
  activation: 'act',
  licenseEvent: 'lev',
  signingKey: 'sig',
} as const

export type IdKind = keyof typeof ID_PREFIXES

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${nano()}`
}
