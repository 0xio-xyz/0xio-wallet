export interface TraitType {
  name: string;
  layer_order?: number;
}

export interface Manifest {
  render_type?: string;
  trait_types?: TraitType[];
  mutability?: string;
  updated_at?: number;
}

export interface TokenAttr {
  trait_type?: string;
  traitType?: string;
  value?: unknown;
}

export interface XpectrumToken {
  image: string | null;
  name: string | null;
  description: string | null;
  animationUrl?: string | null;
}
