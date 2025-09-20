import React, { ReactNode } from "react";

const MagicButton = ({
  title,
  type,
  icon,
  handleClick,
  otherClasses,
}: {
  title: string;
  type: "submit" | "reset" | "button";
  icon?: ReactNode;
  handleClick?: () => void;
  otherClasses?: string;
}) => {
  return (
    <button
      type={`${type}`}
      className="relative my-8 sm:my-11 inline-flex  overflow-hidden rounded-lg p-[2px]"
    >
      <span className="absolute inset-[-1000%] animate-[spin_2s_linear_infinite] bg-[conic-gradient(from_90deg_at_50%_50%,#E2CBFF_0%,#393BB2_50%,#E2CBFF_100%)]" />
      <span
        className={`inline-flex h-full w-full gap-2 md:gap-4 cursor-pointer items-center justify-center rounded-lg bg-black-100 px-4 sm:px-6 py-2 sm:py-3 text-xs sm:text-sm font-medium text-white backdrop-blur-3xl ${otherClasses}`}
        onClick={handleClick}
      >
        {title} {icon}
      </span>
    </button>
  );
};

export default MagicButton;
