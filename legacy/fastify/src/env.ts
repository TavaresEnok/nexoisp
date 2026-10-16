function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`variável de ambiente obrigatória ausente: ${name}`);
  return v;
}
export const env = {
  dbApp: () => req('DATABASE_URL_APP'),
  dbOwner: () => req('DATABASE_URL_OWNER'),
  appDbPassword: () => process.env.NEXO_APP_DB_PASSWORD ?? new URL(req('DATABASE_URL_APP')).password,
  demoMode: process.env.NEXO_DEMO_MODE === '1',
  port: Number(process.env.PORT ?? 8080),
};
