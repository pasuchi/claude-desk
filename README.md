# Claude Desk

App de escritorio para macOS que usa Claude con **tu propio token** (sin iniciar sesión con usuario y contraseña), con soporte para **servidores MCP**, **agentes** y **skills**.

## Instalar

1. En este repositorio de GitHub entra en **Releases** (columna derecha) y descarga el `.dmg` de tu Mac:
   - Apple Silicon (M1/M2/M3/M4): el archivo que contiene `arm64`
   - Intel: el archivo sin `arm64`
2. Ábrelo y arrastra **Claude Desk.app** a `/Aplicaciones`.
3. La app no está firmada con un certificado de Apple. La primera vez, abre la Terminal y ejecuta:

   ```bash
   xattr -cr "/Applications/Claude Desk.app"
   ```

   ```bash
   codesign --force --deep -s - "/Applications/Claude Desk.app"
   ```

   Después ábrela con normalidad (o clic derecho → Abrir).

## Configurar el token

1. Crea una API key en <https://console.anthropic.com/settings/keys>.
2. En la app ve a **🔑 Token y ajustes**, pega la key y pulsa **Guardar y verificar**.
   La app la comprueba contra la API de Anthropic y la guarda cifrada en el Llavero de macOS.

Se aceptan API keys (`sk-ant-api…`) y otros tokens de acceso de la API de Anthropic.
El uso se cobra en tu cuenta de la Console según los tokens consumidos.

## Funciones

- **Chat** con streaming, razonamiento visible, Markdown, imágenes adjuntas e historial guardado.
- **Modelos:** Claude Opus 5.5 (por defecto), Fable 5.2, Sonnet 5.5 y Haiku 5.5, con nivel de esfuerzo configurable.
- **Agentes:** cada uno tiene nombre, modelo, esfuerzo, instrucciones (system prompt), sus servidores MCP, sus skills, búsqueda web opcional y confirmación de herramientas opcional.
- **Servidores MCP:**
  - Locales (stdio), p. ej. comando `npx`, argumentos `-y @modelcontextprotocol/server-filesystem /Users/TU_USUARIO/Documents`.
  - Remotos (HTTP streamable o SSE) con URL y cabeceras (p. ej. `Authorization: Bearer …`).
  - Con el botón **Probar** ves las herramientas que ofrece cada servidor.
- **Skills:** carpetas con `SKILL.md` (formato Agent Skills: frontmatter `name` y `description` + instrucciones). Puedes crearlas desde la app, importar una carpeta existente o abrir la carpeta de skills. Claude ve la descripción y carga la skill completa (y sus archivos de apoyo) solo cuando la necesita.

Los datos se guardan en `~/Library/Application Support/Claude Desk/` (`agents.json`, `mcp.json`, `chats.json`, `skills/`).

## Compilar desde el código (en tu Mac)

```bash
npm install
```

```bash
npm start
```

```bash
npm run dist
```

`npm run dist` genera el `.dmg` y el `.zip` en `dist/`.
