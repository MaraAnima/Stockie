const nodemailer = require("nodemailer");

async function enviarMailError(asunto, mensaje) {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", // ej: smtp.gmail.com
    port: 587,
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
    },
  });

  const mailOptions = {
    from: `"Bot de Stock" <${process.env.MAIL_USER}>`,
    to: process.env.MAIL_TO,
    subject: asunto,
    text: mensaje,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("📧 Mail de error enviado correctamente");
  } catch (error) {
    console.error("❌ Error enviando mail:", error);
  }
}

module.exports = enviarMailError;
