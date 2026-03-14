
export function generateRef(prefix: string): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

export function generateTokenCode(institutionCode: string): string {
  const prefix = institutionCode.substring(0, 3).toUpperCase();
  const p1 = Math.floor(10000 + Math.random() * 90000);
  const p2 = Math.floor(10000 + Math.random() * 90000);
  return `${prefix}-${p1}-${p2}`;
}

export function generateSerialNumber(): string {
  const p1 = Math.floor(10000 + Math.random() * 90000);
  const p2 = Math.floor(10000 + Math.random() * 90000);
  return `SN-${p1}-${p2}`;
}

export function generateTicketNumber(): string {
  return generateRef('TKT');
}
