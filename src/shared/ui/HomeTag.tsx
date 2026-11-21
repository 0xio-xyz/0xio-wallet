import React from 'react';

const TONE = {
  red: 'bg-danger/15! text-danger! hover:bg-danger/25!',
  amber: 'bg-caution/15! text-caution! hover:bg-caution/25!',
  blue: 'bg-info/15! text-info! hover:bg-info/25!',
} as const;

const HomeTag = ({
  tone,
  dot = false,
  title,
  onClick,
  children,
}: {
  tone: keyof typeof TONE;
  dot?: boolean;
  title?: string;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button type="button" onClick={onClick} title={title} className={`press home-tag ${TONE[tone]}`}>
    {dot && <span className="home-tag-dot" aria-hidden="true" />}
    {children}
  </button>
);

export default HomeTag;
