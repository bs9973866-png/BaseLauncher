# Base Launcher

Лаунчер Minecraft на Electron.

- Вход через **Ely.by** (authlib-injector, скины Ely.by) и оффлайн-ники
- **Все версии** Minecraft из официального манифеста Mojang (release / snapshot / old_beta / old_alpha)
- Загрузчик **Fabric** (Vanilla / Fabric на выбор при создании сборки)
- Поиск и скачивание модов, ресурспаков и шейдеров из **Modrinth** и **CurseForge** прямо в папку выбранной сборки
- Java скачивается автоматически (Adoptium), нужная версия подбирается под версию игры
- Иконка — пиксельная база

## Как получить установщик .exe

### Вариант 1: на своём ПК с Windows
1. Установите Node.js LTS: https://nodejs.org
2. Запустите `build.bat`
3. Установщик появится в `dist\BaseLauncher-Setup-1.0.0.exe`

Или вручную: `npm install`, затем `npm run dist`. Для запуска без установки: `npm start`.

### Вариант 2: через GitHub
Загрузите проект в репозиторий и запустите workflow **Build Windows installer** (вкладка Actions). Готовый .exe будет в artifacts.

## CurseForge
CurseForge требует личный API-ключ (бесплатно): https://console.curseforge.com.
Вставьте его в Настройки → API-ключ CurseForge. Некоторые моды запрещают скачивание вне сайта — для них лаунчер покажет сообщение.

## Ограничения
- Forge/NeoForge пока не устанавливаются автоматически (только Vanilla и Fabric). Моды Forge из CurseForge можно скачать, но для запуска нужен Forge.
- Модпаки (.mrpack / CurseForge-сборки) пока не поддерживаются, только отдельные моды, ресурспаки и шейдеры.
- Код написан без возможности запустить Electron в среде разработки, поэтому при первом запуске возможны мелкие недочёты.
