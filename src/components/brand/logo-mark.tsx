interface LogoMarkProps {
  size?: number;
  className?: string;
  idSuffix?: string;
}

export function LogoMark({ size = 20, className }: LogoMarkProps) {
  return (
    <svg
      width={size}
      height={Math.round(size * 0.8)}
      viewBox="0 0 110 88"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        fill="#1B3A6B"
        d="M8 22C8 14 14 8 22 8L28 8C32 8 36 11 37 15L39 25C40 29 38 34 34 35L31 37C34 46 42 54 51 57L53 54C55 50 59 48 63 49L73 52C77 53 80 57 80 62L80 68C80 76 74 82 66 82C38 82 8 52 8 24Z"
      />
      <path
        d="M54 40L63 40L67 25L74 55L79 33L84 46L91 40L104 40"
        stroke="#29B6E2"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
