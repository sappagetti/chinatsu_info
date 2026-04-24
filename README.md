# Chinatsu Info

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Made with Cursor](https://img.shields.io/badge/vibe--coded%20with-Cursor-5E5CE6)](https://cursor.com/)

アーケード音ゲー **オンゲキ** プレイヤー向けの非公式レーティング・スコア分析 Web アプリです。
ブックマークレットで `ongeki-net.com` からプレイ記録を取り込み、レーティング計算・対象曲シミュレーション・達成度の可視化を提供します。

> ⚠️ 非公式・非営利のファンプロジェクトです。株式会社セガとは一切関係ありません。
> ONGEKI および関連ロゴは株式会社セガの商標です。

---

## 主な機能

- **スコア取込**: ブックマークレットが `ongeki-net.com` からプレイ履歴を取得しサーバーにアップロード
- **レーティング計算**: New/Old 枠の分離、プラチナランク対応
- **レーティング対象シミュレータ**: 任意の曲で目標スコアを取った場合のレート増分を算出
- **達成ボード**: 難易度・レベル・バージョン別のクリア状況を可視化
- **アカウント機能**: メール認証・パスワードリセット・Cloudflare Turnstile CAPTCHA・セッション / Remember トークン

## 使い方

```bash
cp .env.example .env
cp backend/.env.example backend/.env
docker compose up --build -d
```

## データ出典

楽曲メタデータ (`music-ex.json`) は [zvuc/otoge-db](https://github.com/zvuc/otoge-db) の公開データを MIT ライセンスのもとで利用しています。バックエンドは 24 時間ごとに上流をポーリングし、`/api/v1/music-ex.json` としてミラー配信します。

## 開発環境

本プロジェクトは [Cursor](https://cursor.com/) による **バイブコーディング (vibe coding)** で作られました。

## ライセンス

[MIT License](./LICENSE) © 2026 sappagetti
