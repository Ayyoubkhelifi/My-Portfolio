import React from "react";
import { Spotlight } from "../ui/Spotlight";
import { GridBackgroundDemo } from "../ui/GridBackground";
import { TextGenerateEffect } from "../ui/TextGenerateEffect";
import MagicButton from "../ui/MagicButton";
import { FaLocationArrow } from "react-icons/fa";

const Hero = () => {
  return (
    <div className="w-full h-screen">
      {" "}
      <GridBackgroundDemo />
      <Spotlight
        className="top-10 -left-10 md:-top-10 md:left-10 sm:top-20 w-[250%] md:w-[160%]"
        fill="white"
      />
      <Spotlight
        className="-top-23 left-70 md:left-200 md:-top-20 sm:left-90 sm:-top-20 w-screen "
        fill="purple"
      />
      <Spotlight
        className="-top-30 left-80 md:left-230 md:-top-30 sm:left-100 sm:-top-30 w-screen "
        fill="blue"
      />{" "}
      <div className="w-full h-full flex justify-center items-center">
        <div className="flex flex-col items-center justify-around h-full max-w-[89vw] md:max-w-[80vw] lg:max-w-[80vw]">
          <div className="flex flex-col items-center justify-end-safe h-full">
            <h2 className="uppercase tracking-widest text-center text-xs text-blue-100 z-20">
              Dynamic web magic with Next.js
            </h2>
            <TextGenerateEffect
              words={"Hi, Welcome To My Portfolio"}
              className="text-center text-3xl md:text-5xl lg:text-6xl py-7"
            />
            <p className="text-center text-xs uppercase tracking-wider text-blue-100 pt-1 z-20">
              I am Khelifi Ayyoub, Cyber Security Engineer And Full Stack Dev
            </p>
          </div>
          <div className="h-full flex items-center justify-center">
            {" "}
            <a href="#about">
              <MagicButton
                title={"Show My Work"}
                type={"button"}
                icon={<FaLocationArrow />}
              />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Hero;
