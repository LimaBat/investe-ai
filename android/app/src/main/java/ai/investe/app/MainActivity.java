package ai.investe.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

import java.net.HttpURLConnection;
import java.net.URL;

/** Tela do Investe.AI: roda o programa em Python no próprio celular e mostra a interface num WebView. */
public class MainActivity extends Activity {
    static final String ENDERECO = "http://127.0.0.1:47615/";
    static volatile boolean pythonIniciado = false;
    static volatile String erroPython = null;
    WebView web;
    String loginPendente = null;  // volta do login do Google (investeai://login?...)
    volatile boolean servidorPronto = false;

    static final String CARREGANDO = "<html><body style='margin:0;background:#0b1020;color:#e8ecf6;font-family:sans-serif;"
            + "display:flex;align-items:center;justify-content:center;height:100vh;text-align:center'><div>"
            + "<div style='font-size:26px;font-weight:700;background:linear-gradient(135deg,#5eead4,#8b5cf6);-webkit-background-clip:text;color:transparent'>Investe.AI</div>"
            + "<p style='color:#9aa6c0'>Carregando… na primeira vez pode levar até um minuto.</p></div></body></html>";

    @Override
    protected void onCreate(Bundle estado) {
        super.onCreate(estado);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0b1020"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportMultipleWindows(false);  // links que abrem nova aba caem no shouldOverrideUrlLoading
        s.setUserAgentString(s.getUserAgentString() + " InvesteAIAndroid/1");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                String h = u.getHost();
                if (h != null && (h.equals("127.0.0.1") || h.equals("localhost"))) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { Log.w("InvesteAI", e); }
                return true;  // sites de fora (notícias, login do Google, downloads) abrem no navegador
            }
        });
        // Android 15 desenha atrás do relógio e da barra de gestos: deixa o espaço deles livre
        FrameLayout raiz = new FrameLayout(this);
        raiz.setBackgroundColor(Color.parseColor("#0b1020"));
        raiz.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        if (Build.VERSION.SDK_INT >= 30) {
            raiz.setOnApplyWindowInsetsListener((v, ins) -> {
                android.graphics.Insets b = ins.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(b.left, b.top, b.right, b.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        setContentView(raiz);
        loginPendente = consultaLogin(getIntent());
        mostrar(CARREGANDO);
        iniciarPython();
        new Thread(this::esperarServidor).start();
    }

    void mostrar(String html) {
        web.loadData(Base64.encodeToString(html.getBytes(java.nio.charset.StandardCharsets.UTF_8), Base64.NO_PADDING), "text/html; charset=utf-8", "base64");
    }

    synchronized void iniciarPython() {
        if (pythonIniciado) return;
        pythonIniciado = true;
        final String pasta = getFilesDir().getAbsolutePath();
        final android.content.Context app = getApplicationContext();
        new Thread(() -> {
            try {
                if (!Python.isStarted()) Python.start(new AndroidPlatform(app));
                Python.getInstance().getModule("investe_android").callAttr("iniciar", pasta);  // fica rodando (servidor)
            } catch (Throwable t) {
                erroPython = String.valueOf(t);
                Log.e("InvesteAI", "Python parou", t);
                pythonIniciado = false;
            }
        }, "investe-python").start();
    }

    void esperarServidor() {
        for (int i = 0; i < 360; i++) {  // até 3 minutos
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(ENDERECO + "api/ping").openConnection();
                c.setConnectTimeout(1000);
                c.setReadTimeout(3000);
                int cod = c.getResponseCode();
                c.disconnect();
                if (cod == 200) {
                    servidorPronto = true;
                    runOnUiThread(() -> {
                        String q = loginPendente;
                        loginPendente = null;
                        web.loadUrl(q != null ? ENDERECO + "oauth/google/callback?" + q + "&fg=1" : ENDERECO);
                    });
                    return;
                }
            } catch (Exception ignorada) { }
            if (erroPython != null) break;
            SystemClock.sleep(500);
        }
        final String msg = erroPython != null ? erroPython : "O programa demorou demais para abrir.";
        runOnUiThread(() -> mostrar("<html><body style='background:#0b1020;color:#e8ecf6;font-family:sans-serif;padding:24px'>"
                + "<h2>Não consegui abrir o Investe.AI</h2><p>Feche o app e abra de novo. Se continuar, avise o desenvolvedor.</p>"
                + "<p style='color:#9aa6c0;font-size:12px'>" + android.text.Html.escapeHtml(msg) + "</p></body></html>"));
    }

    static String consultaLogin(Intent i) {
        if (i == null || i.getData() == null) return null;
        Uri u = i.getData();
        if (!"investeai".equals(u.getScheme()) || u.getEncodedQuery() == null) return null;
        return u.getEncodedQuery();
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        String q = consultaLogin(i);
        if (q == null) return;
        if (servidorPronto && pythonIniciado) web.loadUrl(ENDERECO + "oauth/google/callback?" + q + "&fg=1");
        else loginPendente = q;  // conclui assim que o servidor responder
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!pythonIniciado) {  // o sistema encerrou o Python em segundo plano: inicia de novo
            servidorPronto = false;
            mostrar(CARREGANDO);
            erroPython = null;
            iniciarPython();
            new Thread(this::esperarServidor).start();
        }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);  // não encerra o programa ao voltar
    }
}
