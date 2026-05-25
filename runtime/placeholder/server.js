'use strict';

// Placeholder bundle uploaded to s3://sprout-code-${env}/<projectId>/v0/server.zip
// at project-create time. The shared runtime Lambda loads this when a project
// has no real published code yet — and as a hard fallback when an S3 lookup
// for a real version fails.
exports.handler = async () => ({
  statusCode: 200,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body:
    '<!doctype html><html><head><title>Sprout</title></head>' +
    '<body style="font-family:system-ui;padding:40px;color:#444">' +
    '<h1 style="font-style:italic">This Sprout is starting up&hellip;</h1>' +
    '<p>Your app is ready when you publish it for the first time.</p>' +
    '</body></html>',
});
