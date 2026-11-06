const persona = document.getElementById("persona") as HTMLTextAreaElement
const statusLine = document.getElementById("status") as HTMLSpanElement
const save = document.getElementById("save") as HTMLButtonElement
const reset = document.getElementById("reset") as HTMLButtonElement

function setStatus(message: string) {
  statusLine.textContent = message
}

async function load() {
  persona.value = await window.electron.gift.getPersona()
}

save.addEventListener("click", () => {
  save.disabled = true
  void window.electron.gift
    .savePersona(persona.value)
    .then(() => setStatus("已保存。新会话会使用这版性格。"))
    .catch((error) => setStatus(`保存失败：${String(error)}`))
    .finally(() => {
      save.disabled = false
    })
})

reset.addEventListener("click", () => {
  reset.disabled = true
  void window.electron.gift
    .resetPersona()
    .then((text) => {
      persona.value = text
      setStatus("已恢复默认。保存后生效。")
    })
    .catch((error) => setStatus(`恢复失败：${String(error)}`))
    .finally(() => {
      reset.disabled = false
    })
})

void load().catch((error) => setStatus(`读取失败：${String(error)}`))
