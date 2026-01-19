# Minecraft LLM Bot (Mineflayer + Ollama) — v1.0

Бот на Mineflayer с LLM-ядром (Ollama). Сканирует окружение, хранит память о игроках, принимает решения через LLM и выполняет действия через набор навыков.

Статус: ранняя версия, проект в стадии разработки. Бот может ошибаться и временами «глупит».

## Обзор и архитектура
- `src/index.js`: запуск бота, подключение плагинов (pathfinder, pvp, auto-eat, collectblock).
- `src/llm_client.js`: клиент Ollama, принудительный JSON-формат ответов, выбор модели.
- `src/perception.js`: снимок мира (игроки, мобы, блоки, инвентарь, биом, время).
- `src/planner.js`: режимы поведения, построение контекста, вызовы LLM, обработка действий.
- `src/skills.js`: набор инструментов (follow, mine, craft, chat, give, place и др.).
- `src/task_manager.js`: длинные задачи (например, добыча ресурсов).
- `src/chat.js`: обработка команд, префиксы, кулдауны, mute.
- `src/memory_store.js`: долговременная память о игроках и фактах.
- `src/reflexes.js`: быстрые реакции (авто-еда, уход от крипера).
- `src/observer.js`: реакции на события мира и периодический бантер.

## Возможности
- Режимы: manual / autonomous / survival.
- LLM отвечает строго в JSON и управляет действиями.
- Память о фактах и общении с игроками.
- Навыки добычи, крафта, следования, взаимодействия с блоками.
- Автоматические реакции на угрозы и низкое здоровье.

## Требования
1. **Node.js** установлен.
2. **Ollama установлен и запущен как сервер**:
   - Установить Ollama.
   - Запустить сервер: `ollama serve`.
   - Скачать модель: `ollama pull deepseek-llm` (или свою).
3. **ViaProxy (или аналог) установлен и запущен**:
   - Поднять локальный прокси 1.21.4 -> 1.21.11.
   - Указать локальный порт в `BOT_PORT` или `src/config.js`.

## Панель настройки (Electron)
Есть локальное приложение для быстрой персонализации (включая prompt и модель Ollama).
Запуск:
```bash
npm run app
```
Данные сохраняются в `config.user.json` и `system_prompt.txt` в папке пользовательских данных приложения
(`%APPDATA%\\minecraft-llm-bot` на Windows). Эти файлы в `.gitignore`.

## Сборка Windows .exe
```bash
npm run dist
```
Готовый `.exe` будет в `dist/`. Для панели рекомендуется portable-сборка.

## Установка
```bash
npm install
```

## Настройка
Редактируйте `src/config.js` или используйте переменные окружения:
- `BOT_USERNAME`, `BOT_HOST`, `BOT_PORT`, `BOT_VERSION`, `BOT_AUTH`
- `MC_SERVER_HOST`, `MC_SERVER_PORT`
- `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_CONTEXT`, `OLLAMA_TEMPERATURE`
- `behavior.commandPrefixes` для префикса команд (по умолчанию `bot,`)

## Запуск
Убедитесь, что **Ollama запущен (`ollama serve`)** и **ViaProxy запущен**, затем:
```bash
node src/index.js
```
Или двойной клик по `start_bot.bat`.

## Режимы
- **Manual (по умолчанию)**: бот ждёт команд.
  - Команда: `bot, режим автономный`
- **Autonomous**: бот сам инициирует действия и диалоги.
- **Survival**: приоритет выживания, ресурсов и крафта.

## Команды
- `bot, статус`
- `bot, ко мне`
- `bot, добудь дерево 10`
- `bot, скрафть кирку`

## Файлы
- `src/config.js`: конфигурация подключения и LLM.
- `data/memory.example.json`: шаблон памяти, локально создаётся `data/memory.json`.
- `config.user.json`: пользовательские настройки (создаётся панелью).
- `prompts/system_prompt.txt`: пользовательский system prompt (если создаётся рядом с проектом).
- `%APPDATA%\\minecraft-llm-bot\\config.user.json`: настройки панели (Windows).
- `%APPDATA%\\minecraft-llm-bot\\system_prompt.txt`: system prompt панели (Windows).
