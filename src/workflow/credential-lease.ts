export const targetConnectTimeoutMs = 10_000
export const credentialConnectMarginMs = targetConnectTimeoutMs + 5_000

export class DatabaseCredentialExpiredError extends Error {
  constructor() {
    super('Temporary database credentials expired before connecting')
  }
}
