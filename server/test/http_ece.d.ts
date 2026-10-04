declare module "http_ece" {
  export function decrypt(
    buffer: Buffer,
    params: { version: string; privateKey: unknown; authSecret: string },
  ): Buffer;
}
