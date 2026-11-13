package ai.investe.app;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.os.SystemClock;
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

    /* ---- notificações (reajuste da carteira e dicas da IA), chamadas pelo Python ---- */
    static Context app;
    static Activity atual;
    static final String CANAL = "carteira";

    public static boolean notificar(String titulo, String texto) {
        try {
            Context c = app;
            if (c == null) return false;
            if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                pedirPermissao();
                return false;
            }
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(new NotificationChannel(CANAL, "Carteira e dicas da IA", NotificationManager.IMPORTANCE_DEFAULT));
                b = new Notification.Builder(c, CANAL);
            } else {
                b = new Notification.Builder(c);
            }
            Intent abrir = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(c, 0, abrir, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            b.setSmallIcon(R.mipmap.ic_launcher).setContentTitle(titulo).setContentText(texto)
             .setStyle(new Notification.BigTextStyle().bigText(texto)).setAutoCancel(true).setContentIntent(pi);
            nm.notify((int) (System.currentTimeMillis() % 100000), b.build());
            return true;
        } catch (Exception e) {
            Log.e("InvesteAI", "notificar", e);
            return false;
        }
    }

    public static void pedirPermissao() {
        final Activity a = atual;
        if (a == null || Build.VERSION.SDK_INT < 33) return;
        if (a.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED) return;
        a.runOnUiThread(() -> a.requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 7));
    }

    @Override
    protected void onCreate(Bundle estado) {
        super.onCreate(estado);
        app = getApplicationContext();
        atual = this;
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0b1020"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportMultipleWindows(false);  // links que abrem nova aba caem no shouldOverrideUrlLoading
        s.setUserAgentString(s.getUserAgentString() + " InvesteAIAndroid/1");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                if (limparHistorico && url != null && url.startsWith(ENDERECO)) {
                    limparHistorico = false;
                    v.clearHistory();
                }
            }


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
        carregando();
        iniciarPython();
        new Thread(this::esperarServidor).start();
    }

    static final String TELA = "file:///android_asset/carregando.html";
    boolean limparHistorico = false;

    void carregando() {
        web.loadUrl(TELA);
    }

    /** Termina a barra de progresso e entra no programa. */
    void entrar(String url) {
        web.evaluateJavascript("window.investePronto&&investePronto()", null);
        web.postDelayed(() -> {
            limparHistorico = true;  // o "voltar" não deve cair na tela de carregamento
            web.loadUrl(url);
        }, 1100);
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
                        entrar(q != null ? ENDERECO + "oauth/google/callback?" + q + "&fg=1" : ENDERECO);
                    });
                    return;
                }
            } catch (Exception ignorada) { }
            if (erroPython != null) break;
            SystemClock.sleep(500);
        }
        final String msg = erroPython != null ? erroPython : "O programa demorou demais para abrir.";
        final String texto = "Não consegui abrir o Investe.AI. Feche o app e abra de novo. Se continuar, avise o desenvolvedor. (" + msg + ")";
        runOnUiThread(() -> web.evaluateJavascript("window.investeFalha&&investeFalha(" + org.json.JSONObject.quote(texto) + ")", null));
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
            carregando();
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
