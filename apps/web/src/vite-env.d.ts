/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' active le mode maquette au démarrage (surchargé par le drapeau runtime). */
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
