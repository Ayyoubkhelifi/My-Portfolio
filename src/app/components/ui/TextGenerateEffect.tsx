"use client";
import { useEffect, useRef, memo } from "react";
import {
  AnimationPlaybackControlsWithThen,
  motion,
  stagger,
  useAnimate,
} from "motion/react";
import { cn } from "@/app//lib/utils";

interface TextGenerateEffectProps {
  words: string;
  className?: string;
  filter?: boolean;
  duration?: number;
}

export const TextGenerateEffect = memo<TextGenerateEffectProps>(
  ({ words, className, filter = true, duration = 0.5 }) => {
    const [scope, animate] = useAnimate();
    const wordsArray = useRef(words.split(" "));
    const animationRef = useRef<AnimationPlaybackControlsWithThen | null>(null);

    // Update words array only when words change
    useEffect(() => {
      wordsArray.current = words.split(" ");
    }, [words]);

    useEffect(() => {
      // Cancel previous animation if running
      if (animationRef.current) {
        // Note: motion/react doesn't have a direct cancel method
        // but we can prevent overlapping animations
      }

      const runAnimation = async () => {
        try {
          animationRef.current = animate(
            "span",
            {
              opacity: 1,
              filter: filter ? "blur(0px)" : "none",
            },
            {
              duration,
              delay: stagger(0.1), // Reduced stagger for faster animation
            }
          );
          await animationRef.current;
        } catch (error) {
          // Animation was cancelled or failed
          console.debug("Animation interrupted:", error);
        } finally {
          animationRef.current = null;
        }
      };

      // Use requestAnimationFrame for better timing
      const rafId = requestAnimationFrame(runAnimation);

      return () => {
        cancelAnimationFrame(rafId);
        animationRef.current = null;
      };
    }, [animate, duration, filter, words]);

    return (
      <div className={cn("font-bold", className)}>
        <div
          className="text-center leading-snug tracking-wide min-w-0 flex flex-wrap justify-center items-center"
          ref={scope}
        >
          {wordsArray.current.map((word, idx) => (
            <motion.span
              key={`${word}-${idx}`}
              className={cn(
                idx === 4
                  ? "text-[#CBACF9] text-4xl md:text-5xl lg:text-6xl"
                  : "text-white text-3xl md:text-4xl lg:text-5xl",
                "px-1 inline-block will-change-transform" // Added will-change for better performance
              )}
              initial={{
                filter: filter ? "blur(10px)" : "none",
                opacity: 0,
              }}
            >
              {word}
            </motion.span>
          ))}
        </div>
      </div>
    );
  }
);

TextGenerateEffect.displayName = "TextGenerateEffect";
