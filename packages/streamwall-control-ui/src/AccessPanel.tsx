import { type JSX } from 'preact'
import { useCallback, useState } from 'preact/hooks'
import { type StreamwallRole } from 'streamwall-shared'

export function CreateInviteInput({
  onCreateInvite,
}: {
  onCreateInvite: (invite: { name: string; role: StreamwallRole }) => void
}) {
  const [inviteName, setInviteName] = useState('')
  const [inviteRole, setInviteRole] = useState('operator')
  const handleChangeName = useCallback<JSX.InputEventHandler<HTMLInputElement>>(
    (ev) => {
      setInviteName(ev.currentTarget.value)
    },
    [setInviteName],
  )
  const handleChangeRole = useCallback<
    JSX.InputEventHandler<HTMLSelectElement>
  >(
    (ev) => {
      setInviteRole(ev.currentTarget.value)
    },
    [setInviteRole],
  )
  const handleSubmit = useCallback<JSX.SubmitEventHandler<HTMLFormElement>>(
    (ev) => {
      ev.preventDefault()
      setInviteName('')
      setInviteRole('operator')
      onCreateInvite({ name: inviteName, role: inviteRole as StreamwallRole }) // TODO: validate
    },
    [onCreateInvite, inviteName, inviteRole],
  )
  return (
    <div>
      <form onSubmit={handleSubmit}>
        <input
          onChange={handleChangeName}
          placeholder="Name"
          value={inviteName}
        />
        <select onChange={handleChangeRole} value={inviteRole}>
          <option value="admin">admin</option>
          <option value="operator">operator</option>
          <option value="monitor">monitor</option>
        </select>
        <button type="submit">create invite</button>
      </form>
    </div>
  )
}

export function AuthTokenLine({
  id,
  role,
  name,
  onDelete,
}: {
  id: string
  role: StreamwallRole
  name: string
  onDelete: (id: string) => void
}) {
  const handleDeleteClick = useCallback(() => {
    onDelete(id)
  }, [id, onDelete])
  return (
    <div>
      <strong>{name}</strong>: {role}{' '}
      <button onClick={handleDeleteClick}>revoke</button>
    </div>
  )
}
