# Interfreight Quotation panel

A Lark Base extension for building freight quotations: cost lines (USD/IDR) with margin,
all-in or breakdown pricing, costing + quotation PDFs, and turning accepted quotes into
shipment jobs. It works on the Base it is opened in, as the signed-in Lark user.

Build: `npm install` then `npx esbuild src/app.js --bundle --minify --format=iife --target=es2019 --outfile=dist/app.js`
