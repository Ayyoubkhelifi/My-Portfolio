import { JSX } from "react";

export const navItems: NavItemType[] = [
  { name: "About", link: "#about" },
  { name: "Projects", link: "#projects" },
  { name: "Testimonials", link: "#testimonials" },
  { name: "Contact", link: "#contact" },
];
export interface NavItemType {
  name: string;
  link: string;
  icon?: JSX.Element;
}
