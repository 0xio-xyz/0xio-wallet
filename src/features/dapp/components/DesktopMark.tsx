import Logo from 'src/shared/ui/Logo';

const DesktopMark = ({ size = 30 }: { size?: number }) => (
  <span
    aria-hidden
    className="flex! shrink-0! items-center! justify-center! bg-(--bg-2)!"
    style={{ width: `${size}px`, height: `${size}px`, borderRadius: `${Math.round(size * 0.3)}px` }}
  >
    <Logo size={Math.round(size * 0.62)} />
  </span>
);

export default DesktopMark;
