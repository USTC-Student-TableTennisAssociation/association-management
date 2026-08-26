declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module "*.svg" {
  const source: string;
  export default source;
}

declare module "*.png" {
  const source: string;
  export default source;
}
