// One error type for everything the UI should show to a person.
// `code` is machine-readable (BAD_PIN, OFFLINE, NO_FUNDS, ...); `message` is plain language.
export class WalletError extends Error {
  constructor(code, message, data = {}) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
    Object.assign(this, data);
  }
}
