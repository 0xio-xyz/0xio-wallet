export const shortAddress = (address: string) =>
  address.length > 16 ? `${address.slice(0, 8)}...${address.slice(-5)}` : address;

export const middleCut = (address: string, head = 14, tail = 12) =>
  address.length > head + tail + 3
    ? `${address.slice(0, head)}...${address.slice(-tail)}`
    : address;

export const stepEnter = (dir: 'fwd' | 'back' | null) => (dir ? 'step-xfade' : '');
