import type { FeeFigure } from 'src/features/bridge/bridgeUsd';

const FeeFigureText = ({ fee }: { fee: FeeFigure }) => (
  <>
    {fee.primary}
    {fee.secondary && (
      <span style={{ marginLeft: '6px', fontSize: '11.5px', color: 'var(--fg-3)' }}>
        {fee.secondary}
      </span>
    )}
  </>
);

export default FeeFigureText;
