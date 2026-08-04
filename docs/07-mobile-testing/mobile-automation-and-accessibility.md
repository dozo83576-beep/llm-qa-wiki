---
title: "Мобильная автоматизация и доступность"
category: "mobile"
updated: "2026-08-03"
status: "active"
tags: ["appium", "maestro", "talkback", "voiceover", "switch-access"]
source_priority: "official-docs"
---

# Мобильная автоматизация и доступность

Комбинированный подход: Appium или Maestro повторяют критичный flow, а assistive technologies на
реальном устройстве проверяют, доступен ли тот же результат пользователю.

## Когда использовать

- Регресс повторяется на Android/iOS или заявлены требования доступности.
- Нужно доказать корректные accessible name, focus order, gestures и системные разрешения.

## Когда не использовать

- Как замену реальным устройствам для жестов, клавиатуры, уведомлений и производительности.
- Для iOS-автоматизации на Windows: XCUITest требует macOS и Xcode. Windows может управлять Android;
  iOS-прогон переносится на Mac или согласованный device farm без передачи ПДн.

## Как это делается

1. Выбрать Appium для кросс-платформенного WebDriver-подхода или Maestro для коротких декларативных
   flows. Локаторы строить по accessibility id/видимому имени, не по координатам.
2. На Android вручную пройти ключевой flow с TalkBack и Switch Access: порядок фокуса, озвучивание
   роли/состояния, достижимость действий без сложного жеста.
3. На iOS повторить с VoiceOver и Switch Control: focus, rotor/gestures, labels, ошибки и возврат
   фокуса после modal/navigation.
4. Зафиксировать ОС, модель, app build, assistive technology и ожидаемый результат каждого шага.

## Частые ошибки

- Успешный tap по координате скрывает недоступный control.
- Эмулятор объявляется достаточным доказательством поведения assistive technology.
- Один и тот же сценарий заявляется проверенным на iOS без macOS/Xcode или реального прогона.

## Проверка

- Автотест использует семантические локаторы и стабильно проходит на чистом состоянии.
- Ключевой сценарий отдельно пройден TalkBack/VoiceOver и Switch Access/Control.
- Ограничения платформы честно указаны в отчёте.

## Источники

- [Appium](https://github.com/appium/appium) — проверено 2026-08-03.
- [Maestro](https://github.com/mobile-dev-inc/Maestro) — проверено 2026-08-03.
- [Android accessibility testing](https://developer.android.com/guide/topics/ui/accessibility/testing) — проверено 2026-08-03.
- [Appium XCUITest requirements](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/system-requirements/) — проверено 2026-08-03.
