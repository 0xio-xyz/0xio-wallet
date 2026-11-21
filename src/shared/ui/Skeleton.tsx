import React from 'react';

export const Bone = ({
  w,
  h,
  r,
  style,
}: {
  w?: number | string;
  h?: number | string;
  r?: number;
  style?: React.CSSProperties;
}) => (
  <i
    aria-hidden="true"
    className="skeleton"
    style={{ width: w, height: h, borderRadius: r, ...style }}
  />
);

export const BoneLine = ({ size, w, h }: { size: number; w: number | string; h: number }) => (
  <span style={{ display: 'block', fontSize: `${size}px` }}>
    <Bone w={w} h={h} />
  </span>
);

export const Loading = ({
  label,
  children,
  style,
  className,
}: {
  label: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) => (
  <div role="status" aria-busy="true" aria-label={label} className={className} style={style}>
    {children}
  </div>
);
