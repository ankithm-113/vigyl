/**
 * Loading the Firebase service account, without putting it anywhere it can leak.
 */
import { readFileSync } from 'node:fs';

export interface ServiceAccount {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
}

export interface CredentialSource {
  readonly env?: Record<string, string | undefined>;
  readonly readFile?: (path: string) => string;
}

/** The fields firebase-admin needs; anything else in the file is ignored. */
function validate(parsed: unknown, origin: string): ServiceAccount {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${origin} is not a JSON object`);
  }
  const account = parsed as Record<string, unknown>;
  for (const field of ['project_id', 'client_email', 'private_key'] as const) {
    if (typeof account[field] !== 'string' || account[field] === '') {
      throw new Error(`${origin} is missing "${field}" — is it a service account key?`);
    }
  }
  return account as unknown as ServiceAccount;
}

/**
 * Read the service account from `FIREBASE_SERVICE_ACCOUNT` (base64 of the JSON)
 * or `FIREBASE_SERVICE_ACCOUNT_FILE` (a path).
 *
 * The base64 form is what the build guide specifies and what survives being put
 * in an env var. The file form exists because it is what the Firebase console
 * hands you, and copying a path is safer than copying a private key.
 *
 * Errors never quote the value. A malformed key is still a key.
 */
export function loadServiceAccount(source: CredentialSource = {}): ServiceAccount {
  const env = source.env ?? process.env;
  const read = source.readFile ?? ((path: string) => readFileSync(path, 'utf8'));

  const encoded = env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (encoded) {
    let decoded: string;
    try {
      decoded = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid base64');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT did not decode to JSON. It should be the ' +
          'base64 of the whole service account file.',
      );
    }
    return validate(parsed, 'FIREBASE_SERVICE_ACCOUNT');
  }

  const path = env.FIREBASE_SERVICE_ACCOUNT_FILE?.trim();
  if (path) {
    let contents: string;
    try {
      contents = read(path);
    } catch {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT_FILE points at a file that cannot be read: ${path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error(`${path} is not valid JSON`);
    }
    return validate(parsed, path);
  }

  throw new Error(
    'No Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT (base64 of the ' +
      'service account JSON) or FIREBASE_SERVICE_ACCOUNT_FILE (a path to it). ' +
      'Get one from Firebase console → Project settings → Service accounts.',
  );
}
