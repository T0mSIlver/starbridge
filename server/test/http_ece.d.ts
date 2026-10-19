declare module "http_ece" {
  export function decrypt(
    buffer: Buffer,
    params: { version: string; privateKey: unknown; authSecret: string },
  ): Buffer;
  export function encrypt(
    buffer: Buffer,
    params: { version: string; dh: string; privateKey: unknown; salt: string; authSecret: string },
  ): Buffer;
}
